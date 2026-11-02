# Dashboard engineering

Use SNode.C's installed CMake package; do not depend on personal source paths.
Follow the MQTTCli MQTT callbacks, MQTTBroker Express/static middleware and SSE
receiver lifecycle, and SNode.C MariaDB asynchronous query interfaces.
MQTTStore alone writes telemetry. Dashboard database access is read-only.
Mock TTN JSON is provisional; keep fixtures, schema, projection and UI consistent.
Serve web files from disk. Never embed or bundle them into the executable.

The canonical checkout is this directory, branch `feat/ttn-dashboard`. The remote
is `git@github.com:SNodeC/mqttdashboard.git`; the initial default branch is `main`.
The initial publication places the same root commit on `main` and the task branch.
Persistent builds use `build/codex/<configuration>`; temporary checks use
`/tmp/codex/build/ttn-dashboard/<task>`. No additional source checkouts are needed.

The committed formatting/analysis baseline comes from `~/.codex/formatting/`
(baseline manifest dated 2026-10-15). CMake includes its unchanged format modules;
all application C++ is under `src/`. Formatting is explicit, never part of builds.
Use `compile_commands.json` for clangd and the optional CMake clang-tidy setting.
HTML, CSS and browser JavaScript require no transpilation or package installation.

The reusable-host task starts at 407 application C++ lines under `src/` and has an
explicit +100 net-line allowance (maximum 507 after canonical formatting). Obtain
owner approval before exceeding it. Do not move application code into dependencies
or compress source to evade that bound.

The owner approved Inja as a dependent repository. `checkouts/inja` is the tracked
Git submodule from `https://github.com/pantor/inja.git`, pinned to v3.5.0 at
`7d1b4600b68595085a949743331c2e5673f511ea`. Keep it unchanged as a permanent
declared dependency; its cleanup condition is removal of the dependency itself.
Other task checkouts under the ignored `checkouts/` remain excluded from Git.
Consume Inja's documented public header-only interface; do not fetch it during
CMake configuration or refer to another project's checkout.

The whole web directory is externally supplied. Routes and profile presentation
belong to `public/site.json`, rendering to Inja templates, and projection read/live
adaptation to `model.json` outside the static mount. The mount selects `public/`. Do not
hardcode overview pages, device types, page hierarchies or project SQL in C++.
Templates receive copied request parameters before asynchronous database work.
Keep the existing API shape and storage/live distinction intact.

The owner explicitly accepts SNode.C StaticMiddleware's lack of root containment.
Directory separation is not a security boundary: traversal and escaping symlinks
can expose files readable by the process. Keep this limitation documented and the
containment test marked as an expected failure. Do not change SNode.C or introduce
a downstream path filter as part of this task; this is not a deployment gate.

The only shared formatting-module adaptation excludes `checkouts/` and `build/`
from CMake file discovery. Canonical style/analysis options remain unchanged.

Preserve the global single-return and braced-block rules in new code.
