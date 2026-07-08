// #1812: no import of `UniqueBase` at all. The only same-language-family
// (TypeScript/JS) declaration in the fixture is moduleA/Base.ts's
// `UniqueBase` — the last-resort global fallback must land there, and must
// never link to the cross-language decoy/UniqueBase.py declaration.
export class Orphan extends UniqueBase {}
