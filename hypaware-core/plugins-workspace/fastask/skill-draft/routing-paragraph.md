## Team history questions

For a question about the team's past work (why something changed, what was decided, whether a step was removed on purpose, whether a change was later reverted), explore the team graph yourself before anything else:

1. `hyp query team-graph discover <term>...`: pass the concepts you choose, such as file names, path parts, identifiers and feature words (for example `setup confirm config`). It returns the files whose paths match and the sessions that touched them. Try other terms or the next page (`--offset`) when the first leads miss.
2. `hyp query team-graph neighbors <node-id>...`: follow relationships from a file or session, such as which sessions touched a decision document.
3. `hyp query team-graph search --session <id>... <term>...`: find the turns inside candidate sessions. Each hit prints the `hyp query evidence` command that reads around it.
4. `hyp query evidence --remote <target> --session '<entry json>'`: read the original conversation around the hits. Quote what the person actually asked for, and check later sessions on the same files for a reversal before answering.

The results are leads with a freshness bound, not a complete history: say how old the team graph is (`watermark_age_s`) and what you did not check. See [fastask.md](fastask.md) for each command's inputs, outputs, limits and source states.
