"""Real-library integration verification; does not substitute a fake converter."""
from pathlib import Path
import json
import shutil
import subprocess
import sys
import uuid
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import raw_hash, wire_hash
from make_samples import make

root = Path(sys.argv[1]).resolve()
make(root / 'samples')
profile = json.loads(Path(sys.argv[2]).read_text())
report = []
for ext in ('pdf', 'docx', 'pptx', 'xlsx'):
    for kind in ('normal', 'boundary', 'invalid'):
        folder = root / f'{kind}-{ext}-{uuid.uuid4().hex}'
        folder.mkdir()
        source = root / 'samples' / f'{kind}.{ext}'
        shutil.copyfile(source, folder / f'input.{ext}')
        task = dict(schemaVersion=1, jobId=uuid.uuid4().hex, attempt=1, fencingToken=uuid.uuid4().hex,
                    sourceVersionId=uuid.uuid4().hex, rawSha256=raw_hash(source.read_bytes()),
                    profileHash=wire_hash(profile), profile=profile, format=ext)
        task.update(domain='synthetic', actorRef='sample-reviewer', deadline=int(time.time()*1000)+profile['timeoutMs']+10000,
                    inputManifestHash=wire_hash([task['sourceVersionId'], task['rawSha256'], task['profileHash']]),
                    outputRootRef=task['jobId'] + '/' + task['fencingToken'])
        (folder / 'task.json').write_text(json.dumps(task), encoding='utf-8')
        subprocess.run([sys.executable, str(Path(__file__).with_name('worker.py')), str(folder)], check=True)
        result = json.loads((folder / 'complete.json').read_text(encoding='utf-8'))
        for artifact in result['artifacts']:
            assert raw_hash((folder / artifact['name']).read_bytes()) == artifact['rawSha256']
        if kind == 'invalid':
            assert result['parseStatus'] == 'failed', result
        else:
            assert result['blocks'], result
            if ext != 'xlsx':
                assert any('80' in b['text'] for b in result['blocks']), result
            if kind == 'boundary':
                assert result['parseStatus'] == 'partial', result
            if ext in ('pdf', 'pptx'):
                assert any(b['locator'].get('page') == 1 for b in result['blocks']), result
        report.append(dict(format=ext, sample=kind, status=result['parseStatus'], warnings=result['warnings'],
                           blocks=len(result['blocks']), doclingVersion=result['doclingVersion']))
        print(json.dumps(report[-1]), flush=True)
(root / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
