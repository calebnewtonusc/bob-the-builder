# Security

## Reporting

Open a private security advisory on GitHub, or email the maintainer. Please do
not open a public issue for a vulnerability.

## Threat model

Bob renders interfaces described by a language model. Model output is untrusted
input, and anything that can influence what the model writes, including the
contents of a document a tool-using agent just read, can influence what it
describes. The library treats it that way.

**Props are allow-listed.** Only prop names a catalog entry declares survive to
the renderer. This is not decoration: props are spread onto React components, so
an undeclared prop is an XSS vector rather than a cosmetic problem.

**Ids are validated** and the `__` prefix is reserved for internal sentinels.

**Data patches are bounded** in array index and pointer depth, so a single line
of model output cannot exhaust memory.

**The sandbox omits `allow-same-origin`.** An iframe with both `allow-scripts`
and `allow-same-origin` is not sandboxed: the framed script can reach the parent
document or remove its own sandbox attribute. `BobSandbox` omits it and both
top-navigation flags by construction, and tests assert that it stays that way.

## What is outside the guarantees

Content rendered through `BobSandbox` is model-authored HTML in an isolated
frame. It cannot reach your document, and nothing about its content is audited or
validated. Use it for one subtree, never for a page.

Your own React components are yours to make safe. Bob guarantees a component only
receives props its catalog entry declared, validated against its schema. What the
component does with them is not something the library can see.
