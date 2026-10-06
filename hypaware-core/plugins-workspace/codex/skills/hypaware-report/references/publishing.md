# Publish reviewed Markdown

Publish only when the user requests it. Use the selected remote and actual
coverage period; resolve an unclear destination before uploading. Reuse login
credentials. If login is required, use `hyp remote login <target>`; publishing
requires the publisher role. Do not use operator-only `--org` for an ordinary
member.

```sh
hyp report publish <report-directory> --kind usage-review --period <YYYY-MM-DD-to-YYYY-MM-DD> --remote <target>
```

A calendar month may use `YYYY-MM`. Upload only supported report Markdown,
without the ledger, raw logs, images, HTML, or assets. The server renders it;
no local render step is needed. Links may use http(s), mailto, page fragments,
or another page in the report. See [report-contract.md](report-contract.md).

When the analysis yields one recommendation rather than a report, publish that
page on its own with `hyp report recommend <recommendation-page>.md --remote
<target>`. Its first `# ` heading is the title. The server wraps it in a report
of kind `recommendation`, mints its `hyprec-` id, and the receipt prints the id
and its `hyp report get` command. If the installed CLI lacks `recommend`
(`hyp report --help`), retain the page and report the limitation.

Return the report ID and a receipt-backed link or `hyp report get` command with
the remote. On failure, retain the sources and report the error; do not silently
change content, format, or destination, or loop on permission/quota/render errors.
Publishing does not apply proposals or upload the underlying log dataset.
