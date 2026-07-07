# Cross-language decoy: same bare name as the TypeScript classes/interfaces
# in moduleA/moduleB, in a completely unrelated language. A pre-#1812
# global-by-name lookup ignored language boundaries, so a TypeScript
# `extends Repository` could resolve here too.
class Repository:
    pass


# Cross-language decoy for the no-import fallback case (see orphan.ts).
class UniqueBase:
    pass
