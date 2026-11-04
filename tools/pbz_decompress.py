import ctypes
import json
import os
import sys
import zlib

DEFAULT_DLL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'oodle-data-shared.dll')
DLL_PATH = os.environ.get('OODLE_DLL') or (sys.argv[3] if len(sys.argv) > 3 else DEFAULT_DLL)

_lib = None


def lib():
    global _lib
    if _lib is None:
        _lib = ctypes.CDLL(DLL_PATH)
        _lib.OodleLZ_Decompress.restype = ctypes.c_ssize_t
        _lib.OodleLZ_Decompress.argtypes = [
            ctypes.c_char_p, ctypes.c_ssize_t, ctypes.c_char_p, ctypes.c_ssize_t,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_ssize_t,
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ssize_t, ctypes.c_int,
        ]
    return _lib


def oodle_decompress(data, size):
    out = ctypes.create_string_buffer(size)
    n = lib().OodleLZ_Decompress(data, len(data), out, size, 1, 0, 0,
                                 None, 0, None, None, None, 0, 3)
    if n != size:
        raise RuntimeError(f'oodle decompress failed: {n} != {size}')
    return out.raw


def main(src, outdir):
    d = json.load(open(os.path.join(src, '_directory.json'), encoding='utf-8'))
    os.makedirs(outdir, exist_ok=True)
    for e in d['table']:
        name = e['name']
        fname = ''.join(c if c.isalnum() or c in '_.-' else '_' for c in name)
        data = open(os.path.join(src, fname + '.bin'), 'rb').read()
        algo = e['algo']
        if algo == 0:
            raw = data
        elif algo == 1:
            raw = zlib.decompress(data)
        elif algo == 2:
            raw = oodle_decompress(data, e['rawSize'])
        else:
            raise RuntimeError(f'unknown algo {algo}')
        assert len(raw) == e['rawSize'], (name, len(raw), e['rawSize'])
        open(os.path.join(outdir, fname + '.json'), 'wb').write(raw)
        print(f'{name}: {len(raw)} bytes')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('usage: python pbz_decompress.py <slots_dir> <json_out_dir> [oodle_dll]')
        print('   or: set OODLE_DLL=...')
        raise SystemExit(1)
    main(sys.argv[1], sys.argv[2])
