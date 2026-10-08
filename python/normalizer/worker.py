"""Docling CLI. Reads a TS-owned task directory; writes products, never SQLite.

Supervisor bounds the entire conversion process tree, including library startup.
The complete manifest is written last. No manifest means no importable result.
"""
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import zipfile
from io import BytesIO

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import raw_hash, wire_hash


def now():
    return int(time.time() * 1000)


def emit(root, task, started, status, warnings, blocks, document=None, markdown=''):
    artifacts = []
    if document is not None:
        for name, data in [('document.json', json.dumps(document, ensure_ascii=False).encode()),
                           ('document.md', markdown.encode()),
                           ('blocks.json', json.dumps(blocks, ensure_ascii=False).encode())]:
            if len(data) > task['profile']['maxExpandedBytes']:
                raise ValueError('OUTPUT_LIMIT')
            with (root / name).open('xb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            artifacts.append({'name': name, 'rawSha256': raw_hash(data), 'bytes': len(data)})
    result = {k: task[k] for k in ['jobId', 'attempt', 'fencingToken', 'sourceVersionId', 'rawSha256', 'profileHash']}
    result.update(schemaVersion=1, doclingVersion=importlib.metadata.version('docling'),
                  startedAt=started, finishedAt=now(), parseStatus=status,
                  warnings=warnings, blocks=blocks, artifacts=artifacts)
    with (root / 'complete.json.tmp').open('w', encoding='utf-8', newline='\n') as f:
        json.dump(result, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(root / 'complete.json.tmp', root / 'complete.json')


def preflight(source, profile):
    if source.stat().st_size > profile['maxBytes']:
        raise ValueError('INPUT_LIMIT')
    suffix = source.suffix.lower()
    warnings = []
    if suffix == '.pdf':
        if not source.read_bytes().startswith(b'%PDF-'):
            raise ValueError('MIME_MISMATCH')
    elif suffix in ('.docx', '.pptx', '.xlsx'):
        with zipfile.ZipFile(source) as z:
            entries = z.infolist()
            if len(entries) > 20000 or sum(e.file_size for e in entries) > profile['maxExpandedBytes']:
                raise ValueError('EXPANDED_LIMIT')
            if any(e.flag_bits & 1 for e in entries):
                raise ValueError('ENCRYPTED_DOCUMENT')
            prefix = {'.docx': 'word/document.xml', '.pptx': 'ppt/presentation.xml', '.xlsx': 'xl/workbook.xml'}[suffix]
            if prefix not in z.namelist() or '[Content_Types].xml' not in z.namelist():
                raise ValueError('MIME_MISMATCH')
            if any('vbaproject' in e.filename.lower() for e in entries):
                raise ValueError('MACROS_FORBIDDEN')
            if any('externallinks/' in e.filename.lower() for e in entries):
                warnings.append('EXTERNAL_LINKS_NOT_EVALUATED')
    else:
        raise ValueError('UNSUPPORTED_FORMAT')
    return warnings


def convert(root, task):
    started = now()
    profile = task['profile']
    warnings = []
    try:
        if profile['doclingVersion'] != importlib.metadata.version('docling'):
            raise ValueError('DOCLING_VERSION_MISMATCH')
        if task['profileHash'] != wire_hash(profile):
            raise ValueError('PROFILE_HASH_MISMATCH')
        source = root / ('input.' + task['format'])
        if raw_hash(source.read_bytes()) != task['rawSha256']:
            raise ValueError('INPUT_HASH_MISMATCH')
        warnings += preflight(source, profile)
        # Parsing cannot fetch remote resources, even if a document embeds them.
        os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', OMP_NUM_THREADS='2')
        import socket
        def deny_network(*args, **kwargs):
            raise RuntimeError('PARSER_NETWORK_DISABLED')
        socket.socket.connect = deny_network
        socket.create_connection = deny_network
        from docling.document_converter import DocumentConverter, NativePdfFormatOption, PdfFormatOption
        from docling.datamodel.base_models import InputFormat, DocumentStream
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        if profile['pipeline'] == 'native':
            if profile['ocr']:
                raise ValueError('NATIVE_OCR_UNSUPPORTED')
            pdf = NativePdfFormatOption()
        else:
            artifacts_path = os.environ.get('DOCLING_ARTIFACTS_PATH')
            if not artifacts_path:
                raise ValueError('MODEL_ARTIFACTS_REQUIRED')
            artifact_root = Path(artifacts_path).resolve()
            inventory = [{'path': p.relative_to(artifact_root).as_posix(), 'rawSha256': raw_hash(p.read_bytes())}
                         for p in sorted(artifact_root.rglob('*')) if p.is_file()]
            if wire_hash(inventory) != profile['modelArtifactsHash']:
                raise ValueError('MODEL_ARTIFACTS_MISMATCH')
            pdf = PdfFormatOption(pipeline_options=PdfPipelineOptions(
                artifacts_path=artifact_root, enable_remote_services=False, do_ocr=profile['ocr']))
        converter = DocumentConverter(allowed_formats=[InputFormat.PDF, InputFormat.DOCX, InputFormat.PPTX, InputFormat.XLSX],
                                      format_options={InputFormat.PDF: pdf})
        conversion_input = DocumentStream(name=source.name, stream=BytesIO(source.read_bytes())) if task['format'] == 'pdf' else source
        result = converter.convert(conversion_input, raises_on_error=False, max_num_pages=profile['maxPages'], max_file_size=profile['maxBytes'])
        document = result.document
        blocks = []
        for item, _ in document.iterate_items():
            text = getattr(item, 'text', '')
            kind = str(getattr(item, 'label', 'unknown').value)
            if kind == 'table':
                text = item.export_to_markdown(doc=document)
            if kind == 'picture':
                warnings.append('PICTURE_CONTENT_REQUIRES_REVIEW:' + item.self_ref)
            if not text:
                continue
            locator = {'precision': 'block', 'pointer': item.self_ref}
            prov = getattr(item, 'prov', [])
            if prov and task['format'] in ('pdf', 'pptx'):
                p = prov[0]
                locator.update(precision='page' if task['format'] == 'pdf' else 'slide', page=p.page_no,
                               bbox=[str(getattr(p.bbox, c)) for c in ('l', 't', 'r', 'b')])
            elif task['format'] == 'xlsx':
                # Docling's sheet group supplies the real name; provenance uses
                # zero-based cell-index boundaries (not PDF points).
                parent = item.parent.resolve(document) if item.parent else None
                box = prov[0].bbox if prov else None
                if parent and str(parent.label.value) == 'sheet' and box and all(float(getattr(box, c)).is_integer() for c in ('l', 't', 'r', 'b')) and box.r > box.l and box.b > box.t:
                    from openpyxl.utils import get_column_letter
                    locator.update(precision='cells', sheet=parent.name,
                                   range=f'{get_column_letter(int(box.l)+1)}{int(box.t)+1}:{get_column_letter(int(box.r))}{int(box.b)}')
                else:
                    warnings.append('TABLE_LOCATOR_BLOCK_LEVEL:' + item.self_ref)
            content_hash = raw_hash(text.encode())
            blocks.append({'blockId': wire_hash([task['sourceVersionId'], task['profileHash'], item.self_ref]),
                           'kind': kind, 'text': text, 'contentHash': content_hash, 'locator': locator,
                           'extractionAllowed': kind != 'table'})
        metadata = document.export_to_dict()
        if task['format'] == 'xlsx':
            # Preserve formula/cached/text distinctions; never calculate formulas.
            from openpyxl import load_workbook
            formulas = load_workbook(source, data_only=False, read_only=True, keep_links=False)
            cached = load_workbook(source, data_only=True, read_only=True, keep_links=False)
            cells = []
            for sheet in formulas:
                for row in sheet:
                    for cell in row:
                        if cell.value is None:
                            continue
                        formula = cell.data_type == 'f'
                        cells.append({'sheet': sheet.title, 'cell': cell.coordinate, 'kind': 'formula' if formula else 'text',
                                      'value': str(cell.value), 'cached': str(cached[sheet.title][cell.coordinate].value) if formula else None})
                        if formula:
                            warnings.append('FORMULA_NOT_EVALUATED:' + sheet.title + '!' + cell.coordinate)
                if sheet.sheet_state != 'visible':
                    warnings.append('HIDDEN_SHEET_REQUIRES_REVIEW:' + sheet.title)
            formulas.close()
            cached.close()
            metadata['wikibotSpreadsheetCells'] = cells
        warnings += ['DOCLING:' + str(e.error_message) for e in result.errors]
        if not blocks:
            warnings.append('NO_TEXT_EXTRACTED')
        if task['format'] == 'pdf' and profile['pipeline'] == 'native':
            # Native conversion does not OCR image-only pages; inspect every page.
            import pypdfium2 as pdfium
            pdf_doc = pdfium.PdfDocument(source)
            for i in range(len(pdf_doc)):
                page = pdf_doc[i]
                tp = page.get_textpage()
                if not tp.get_text_range().strip():
                    warnings.append('PAGE_WITHOUT_NATIVE_TEXT:' + str(i + 1))
                tp.close()
                page.close()
            pdf_doc.close()
        status = 'complete' if str(result.status.value) == 'success' and blocks and not warnings else 'partial'
        if not blocks:
            status = 'failed'
        emit(root, task, started, status, sorted(set(warnings)), blocks, metadata, document.export_to_markdown())
    except Exception as exc:
        # Stable exception categories, no credentials/local path in public status.
        message = str(exc) if isinstance(exc, ValueError) and str(exc).isupper() else type(exc).__name__
        emit(root, task, started, 'failed', warnings + [message], [])


def supervise(root, task):
    import psutil
    start = time.monotonic()
    child = subprocess.Popen([sys.executable, __file__, str(root), '--child'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    process = psutil.Process(child.pid)
    reason = None
    while child.poll() is None:
        try:
            tree = [process] + process.children(recursive=True)
            memory = sum(p.memory_info().rss for p in tree if p.is_running())
            cpu = sum(p.cpu_times().user + p.cpu_times().system for p in tree if p.is_running())
            if memory > task['profile']['memoryMb'] * 1024 * 1024:
                reason = 'MEMORY_LIMIT'
            if cpu > task['profile']['cpuSeconds']:
                reason = 'CPU_LIMIT'
            if (time.monotonic() - start) * 1000 > task['profile']['timeoutMs']:
                reason = 'PARSER_TIMEOUT'
            if reason:
                for p in reversed(tree):
                    try:
                        p.kill()
                    except psutil.NoSuchProcess:
                        pass
                break
        except psutil.NoSuchProcess:
            break
        time.sleep(0.1)
    child.wait()
    if reason or not (root / 'complete.json').exists():
        emit(root, task, now(), 'failed', [reason or 'PARSER_PROCESS_FAILED'], [])


if __name__ == '__main__':
    root = Path(sys.argv[1]).resolve()
    task = json.loads((root / 'task.json').read_text(encoding='utf-8'))
    from jsonschema import validate
    schema_path = Path(__file__).resolve().parents[2] / 'contracts/knowledge/normalization-task-v1.schema.json'
    validate(task, json.loads(schema_path.read_text(encoding='utf-8')))
    if task['inputManifestHash'] != wire_hash([task['sourceVersionId'], task['rawSha256'], task['profileHash']]) or task['outputRootRef'] != task['jobId'] + '/' + task['fencingToken']:
        raise ValueError('TASK_BINDING_MISMATCH')
    if task['deadline'] <= now():
        raise ValueError('TASK_EXPIRED')
    if '--child' in sys.argv:
        convert(root, task)
    else:
        supervise(root, task)
