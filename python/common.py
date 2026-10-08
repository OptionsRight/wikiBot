"""Versioned wire hashes. This deliberately does not implement legacy JS hash()."""
import hashlib
import json


def raw_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value) -> str:
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, str):
        value.encode('utf-8', errors='strict')
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, int) and abs(value) <= 9007199254740991:
        return str(value)
    if isinstance(value, list):
        return '[' + ','.join(canonical(v) for v in value) + ']'
    if isinstance(value, dict):
        if any(not isinstance(k, str) or not k or any(ord(c) < 32 or ord(c) > 126 for c in k) for k in value):
            raise ValueError('INVALID_CONTRACT_KEY')
        return '{' + ','.join(canonical(k) + ':' + canonical(value[k]) for k in sorted(value)) + '}'
    raise ValueError('INVALID_CONTRACT_VALUE')


def wire_hash(value) -> str:
    return raw_hash(canonical(value).encode('utf-8'))
