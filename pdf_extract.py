"""PDF text extraction helper executed by the bundled workspace Python."""

from __future__ import annotations

import sys
from io import BytesIO


def enough_text(value: str) -> bool:
    return len("".join(value.split())) >= 30


def extract_with_ocr(data: bytes, page_limit: int = 12) -> str:
    """Optional local OCR fallback. It is only used when the PDF has no useful text layer."""
    try:
        import fitz
    except ImportError as exc:
        raise ValueError(
            "没有识别到可复制文字；这是扫描版 PDF。请安装本地 OCR 组件，或上传文字版 PDF。"
        ) from exc

    rapid_engine = None
    try:
        from rapidocr import RapidOCR
        rapid_engine = RapidOCR()
    except ImportError:
        try:
            from rapidocr_onnxruntime import RapidOCR
            rapid_engine = RapidOCR()
        except ImportError:
            pass

    pytesseract = None
    Image = None
    if rapid_engine is None:
        try:
            import pytesseract as pytesseract_module
            from PIL import Image as pillow_image
            pytesseract = pytesseract_module
            Image = pillow_image
        except ImportError as exc:
            raise ValueError(
                "没有识别到可复制文字；这是扫描版 PDF。请安装 PyMuPDF 与 rapidocr-onnxruntime，或上传文字版 PDF。"
            ) from exc

    document = fitz.open(stream=data, filetype="pdf")
    if document.page_count > 60:
        raise ValueError("PDF 页数超过 60 页，请只上传求职简历。")
    pages = []
    for page_index in range(min(document.page_count, page_limit)):
        page = document.load_page(page_index)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        png = pixmap.tobytes("png")
        if rapid_engine is not None:
            result = rapid_engine(png)
            if hasattr(result, "txts"):
                text = "\n".join(str(item) for item in (result.txts or []) if str(item).strip())
            else:
                legacy_result = result[0] if isinstance(result, tuple) else result
                text = "\n".join(str(item[1]) for item in (legacy_result or []) if len(item) >= 2)
        else:
            image = Image.open(BytesIO(png))
            try:
                text = pytesseract.image_to_string(image, lang="chi_sim+eng")
            except pytesseract.TesseractError:
                text = pytesseract.image_to_string(image, lang="eng")
        pages.append(text)
    output = "\n".join(pages)
    if not enough_text(output):
        raise ValueError("扫描版 PDF 的 OCR 结果过少，请上传更清晰的文件或文字版 PDF。")
    return output


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
            if enough_text(text):
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
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
        if enough_text(text):
            return text
    except ValueError:
        raise
    except Exception as exc:
        errors.append(str(exc))

    try:
        return extract_with_ocr(data)
    except ValueError:
        raise
    except Exception as exc:
        errors.append(str(exc))
        raise ValueError("PDF 结构异常、已损坏，或本地 OCR 不可用，请重新导出后上传。") from exc


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
