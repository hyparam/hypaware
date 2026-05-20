# Repository Preferences

- Prefer `.d.ts` files for reusable interfaces and public type shapes. Keep inline JSDoc typedefs only for small, private helper shapes that are unlikely to be reused.
- Avoid JavaScript classes unless the value owns lifecycle, resource, timer, event, or mutable protocol state. Prefer plain serializable config objects plus functions for file-backed or stateless behavior.
- Do not add compatibility branches for old layouts or schemas unless the migration risk is explicit and documented.
- Keep user-facing mode names to Standalone, Gateway, and Central server. The JSON schema still uses `role: "server"` for the central server role.
