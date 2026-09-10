"""Read only the known disposable Cursor 3.19.19 conversation, with bounded projection.

This is a research probe, not an importer or supported Cursor interface.
Never exports system prompts, ambient context, thinking, provider options or keys.
"""
import base64
import collections
import hashlib
import json
import sqlite3
from pathlib import Path

SID = 'a04677b4-01ac-478d-a4ef-37ab5ddd0d9a'
DB = Path('/Users/phil/Library/Application Support/Cursor/User/globalStorage/state.vscdb')
BUNDLE = Path('/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js')
OUT = Path(__file__).with_name('editor-storage-evidence.json')
LIMIT = 1024 * 1024


def wire(data):
    if len(data) > LIMIT:
        raise ValueError('record size cap')
    index = 0
    fields = []

    def varint():
        nonlocal index
        value = 0
        for shift in range(0, 70, 7):
            if index >= len(data):
                raise ValueError('truncated varint')
            byte = data[index]
            index += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise ValueError('varint cap')

    while index < len(data):
        tag = varint()
        field, kind = tag >> 3, tag & 7
        if not field:
            raise ValueError('invalid field')
        if kind == 0:
            value = varint()
        elif kind in (1, 2, 5):
            count = varint() if kind == 2 else (8 if kind == 1 else 4)
            value = data[index:index + count]
            index += count
            if len(value) != count:
                raise ValueError('truncated field')
        else:
            raise ValueError('unsupported wire kind')
        fields.append((field, kind, value))
        if len(fields) > 10000:
            raise ValueError('field cap')
    return fields


def field(data, number):
    return next((value for f, _, value in wire(data) if f == number), None)


def blob(connection, pointer):
    if len(pointer) != 32:
        raise ValueError('unexpected pointer')
    row = connection.execute(
        'SELECT typeof(value), value FROM cursorDiskKV WHERE key=? AND length(value)<=?',
        ('agentKv:blob:' + pointer.hex(), LIMIT)
    ).fetchone()
    if row is None:
        raise ValueError('missing or oversize blob')
    value = row[1] if row[0] == 'blob' else bytes.fromhex(row[1])
    if hashlib.sha256(value).digest() != pointer:
        raise ValueError('content hash mismatch')
    return value


def main():
    connection = sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True)
    connection.execute('PRAGMA query_only=ON')
    connection.execute('PRAGMA busy_timeout=1000')
    connection.execute('BEGIN')
    encoded, workspace = connection.execute(
        "SELECT json_extract(value,'$.conversationState'), "
        "json_extract(value,'$.workspaceIdentifier.uri.path') "
        'FROM cursorDiskKV WHERE key=? AND length(value)<=?',
        ('composerData:' + SID, LIMIT)
    ).fetchone()
    assert workspace == '/tmp/hypaware-cursor-live-probe/workspace'
    state = base64.b64decode(encoded[1:]) if encoded.startswith('~') else bytes.fromhex(encoded)
    state_fields = wire(state)
    refs = [value for f, _, value in state_fields if f == 1]
    assert len(refs) <= 100
    messages = []
    ignored = collections.Counter()
    result_counts = collections.Counter()
    native_tool_ids = []
    for position, pointer in enumerate(refs):
        key = 'agentKv:blob:' + pointer.hex()
        # Validate integrity without decoding content into a Python object.
        blob(connection, pointer)
        role, content_type, message_id = connection.execute(
            "SELECT json_extract(value,'$.role'), json_type(value,'$.content'), "
            "json_extract(value,'$.id') FROM cursorDiskKV WHERE key=?", (key,)
        ).fetchone()
        if role not in ('assistant', 'tool') or content_type != 'array':
            ignored['non_assistant_or_tool_message'] += 1
            continue
        blocks = []
        shapes = connection.execute(
            "SELECT json_extract(j.value,'$.type'),count(*) "
            "FROM cursorDiskKV d,json_each(d.value,'$.content') j WHERE d.key=? "
            "GROUP BY json_extract(j.value,'$.type')", (key,)
        ).fetchall()
        for kind, count in shapes:
            if kind not in ('text', 'tool-call', 'tool-result'):
                ignored[kind or 'unknown_block'] += count
        # Explicit JSON paths exclude reasoning, signatures, provider metadata and binary parts.
        rows = connection.execute(
            "SELECT json_extract(j.value,'$.type'),json_extract(j.value,'$.text'),"
            "json_extract(j.value,'$.toolName'),json_extract(j.value,'$.toolCallId'),"
            "json_extract(j.value,'$.args'),json_extract(j.value,'$.result'),"
            "json_type(j.value,'$.result') "
            "FROM cursorDiskKV d,json_each(d.value,'$.content') j WHERE d.key=? "
            "AND json_extract(j.value,'$.type') IN ('text','tool-call','tool-result')", (key,)
        ).fetchall()
        for kind, text, name, tool_id, args, result, result_type in rows:
            block = {'type': kind}
            if kind == 'text':
                block['text'] = text
            else:
                block.update(tool_name=name, tool_call_id=tool_id)
                if kind == 'tool-call':
                    block['args'] = json.loads(args) if args else None
                else:
                    native_tool_ids.append(tool_id)
                    result_counts[name] += 1
                    block.update(result_type=result_type, result_chars=len(result or ''),
                                 result_sha256=hashlib.sha256((result or '').encode()).hexdigest())
                    if name == 'Read' and result == 'The probe value is MARIGOLD-42.\n':
                        block['result'] = result
                    if name == 'Grep':
                        block['sentinel_match_present'] = '1:The probe value is MARIGOLD-42.' in result
                    if name == 'Glob':
                        block['notes_path_present'] = 'notes.txt' in result
                    if name == 'GetDynamicTools':
                        value = json.loads(result)
                        block['result_keys'] = sorted(value)
                        block['describes_cursor_dialog'] = value.get('tool') == 'cursor_dialog'
            blocks.append(block)
        messages.append({'position': position, 'message_id': message_id, 'role': role, 'blocks': blocks})
    turns = []
    for pointer in [value for f, _, value in state_fields if f == 8]:
        turn_bytes = field(blob(connection, pointer), 1)
        turn_fields = wire(turn_bytes)
        user_pointer = next(value for f, _, value in turn_fields if f == 1)
        user_bytes = blob(connection, user_pointer)
        user_fields = wire(user_bytes)
        # Never decode selected context, previous state or identity metadata.
        user = {name: next((v.decode() for f, _, v in user_fields if f == no), None)
                for no, name in [(1, 'text'), (2, 'message_id')]}
        request_id = next((v.decode() for f, _, v in turn_fields if f == 3), None)
        steps = []
        for step_pointer in [v for f, _, v in turn_fields if f == 2]:
            step = blob(connection, step_pointer)
            step_fields = wire(step)
            if any(f == 3 for f, _, _ in step_fields):
                ignored['thinking_step'] += 1
                continue
            assistant = next((v for f, _, v in step_fields if f == 1), None)
            tool = next((v for f, _, v in step_fields if f == 2), None)
            if assistant is not None:
                values = dict((f, v) for f, _, v in wire(assistant))
                steps.append({'kind': 'assistant', 'text': values.get(1, b'').decode(),
                              'started_at_ms': values.get(2), 'completed_at_ms': values.get(3)})
            elif tool is not None:
                values = dict((f, v) for f, _, v in wire(tool))
                steps.append({'kind': 'tool', 'tool_call_id': values.get(57, b'').decode(),
                              'started_at_ms': values.get(59), 'completed_at_ms': values.get(60),
                              'sentinel_bytes_present': b'MARIGOLD-42' in tool})
        turns.append({'user': user, 'request_id': request_id, 'steps': steps})
    connection.rollback()
    connection.close()
    hooks = []
    for line in Path('/tmp/hypaware-cursor-live-probe/evidence/hooks.jsonl').read_text().splitlines():
        row = json.loads(line).get('event', {})
        if row.get('conversation_id') == SID:
            hooks.append(row)
    hook_counts = collections.Counter(row.get('hook_event_name') for row in hooks)
    tool_hooks = [row for row in hooks if row.get('hook_event_name') == 'postToolUse']
    hook_ids = {row.get('tool_use_id') for row in tool_hooks}
    exact = sum(tool_id in hook_ids for tool_id in native_tool_ids)
    # Report representation differences as evidence, not a production normalization rule.
    newline_normalized = sum(tool_id.replace('\\n', '\n') in hook_ids for tool_id in native_tool_ids)
    result = {'client_version': '3.19.19', 'conversation_id': SID,
              'source_bundle_sha256': hashlib.sha256(BUNDLE.read_bytes()).hexdigest(),
              'root_message_count': len(refs), 'tool_result_counts': dict(result_counts),
              'excluded_counts': dict(ignored), 'hook_counts': dict(hook_counts),
              'native_result_ids_matching_hooks_exactly': exact,
              'native_result_ids_matching_hooks_after_literal_newline_conversion': newline_normalized,
              'turns': turns, 'projected_messages': messages}
    OUT.write_text(json.dumps(result, indent=2, ensure_ascii=True) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ('turns', 'projected_messages')}))


if __name__ == '__main__':
    main()
