- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

---

Write every mdtest paragraph, code comment, piece of documentation, PR description, and GitHub issue for its eventual reader, not for the current Codex conversation. Determine the reader's knowledge, purpose, and likely questions privately; do not add an audience-analysis section to the artifact.

Base public-facing text on the final code, complete final diff, relevant issue, and verified evidence. Explain the observable behavior or problem before implementation details. Use established technical terminology and the actual names of types, functions, files, and invariants.

Do not mention discarded alternatives, intermediate edits, private instructions, tool usage, branch or draft status, local test commands, or session history unless the reader needs that information to understand the final result. Do not describe reverted changes as part of the final change.

Preserve useful human-written comments unless the code change makes them inaccurate. Before finishing, reread each changed artifact as someone with no access to the Codex session and remove or explain anything that would surprise or confuse that reader.

---

- Prefer `uv` for Python dependency management, environments, and command execution. Use `uv add` and `uv remove` to manage project dependencies instead of `pip install`, `pip uninstall`, or their `uv pip` equivalents, and use `uv run` to execute Python commands. When a shared Python environment is needed, use `~/.agent/.venv` instead of the system Python environment.
- Use `mise` as the default tool and runtime manager, and pin mise-managed tools to `latest`. Whenever supported, install and manage npm- and Bun-related tools and packages through `mise` as well.
