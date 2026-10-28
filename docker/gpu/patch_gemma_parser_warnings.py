"""Bound repeated malformed-input diagnostics without changing parsed arguments."""

def patch_source(source):
    for kind in ('args', 'array'):
        before = ('                logger.warning(\n'
                  f'                    "Gemma4 {kind} parser made no progress at position %d; "\n'
                  '                    "aborting on malformed input.",\n'
                  '                    i,\n'
                  '                )')
        after = ('                logger.warning_once(\n'
                 f'                    "Gemma4 {kind} parser made no progress; "\n'
                 '                    "aborting on malformed input (repeated warnings suppressed)."\n'
                 '                )')
        if source.count(after) == 1 and before not in source:
            continue
        if source.count(before) != 1:
            raise RuntimeError('Unrecognized Gemma warning guard: ' + kind)
        source = source.replace(before, after, 1)
    compile(source, 'gemma4.py', 'exec')
    return source
