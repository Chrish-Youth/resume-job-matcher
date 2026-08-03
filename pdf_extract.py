"""PDF text extraction helper executed by the bundled workspace Python."""

from __future__ import annotations

import sys
from io import BytesIO


def extract(data: bytes) -> str:
    errors: list[str] = []
    try:
        import pdfplumber

        with pdfplumber.open(BytesIO(data)) as document:
            if len(document.pages) > 60:
                raise ValueError("PDF 页数超过 60 页，请只上传求职简历。")
            text = "\n".join(
                page.extract_text(x_tolerance=2, y_tolerance=3) or ""
                for page in document.pages
            )
            if text.strip():
                return text
    except ValueError:
        raise
    except Exception as exc:
        errors.append(str(exc))

    try:
        from pypdf import PdfReader

        reader = PdfReader(BytesIO(data))
        if reader.is_encrypted:
            raise ValueError("PDF 已加密，请先取消打开密码后重新上传。")
        if len(reader.pages) > 60:
            raise ValueError("PDF 页数超过 60 页，请只上传求职简历。")
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except ValueError:
        raise
    except Exception as exc:
        errors.append(str(exc))
        raise ValueError("PDF 结构异常或已损坏，请重新导出后上传。") from exc


def main() -> None:
    try:
        data = sys.stdin.buffer.read()
        if not data.startswith(b"%PDF-"):
            raise ValueError("文件内容不是有效的 PDF，请重新导出简历后上传。")
        sys.stdout.buffer.write(extract(data).encode("utf-8"))
    except ValueError as exc:
        sys.stderr.buffer.write(str(exc).encode("utf-8"))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
