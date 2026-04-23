#!/usr/bin/env python3

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve()
OUTPUT_DIR = SCRIPT_PATH.parent
PROJECT_ROOT = OUTPUT_DIR.parent.parent
SEASONAL_ROOT = PROJECT_ROOT / "images" / "seasonal"
OUTPUT_JSON = OUTPUT_DIR / "seasonal_card_text.json"
OUTPUT_TEXT = OUTPUT_DIR / "seasonal_card_text.txt"

LANG = "chi_sim+eng"
PSM = "11"


def normalize_text(raw: str) -> list[str]:
    lines = []
    seen = set()
    for line in raw.splitlines():
        cleaned = re.sub(r"\s+", " ", line).strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        lines.append(cleaned)
    return lines


def run_tesseract(image_path: Path) -> list[str]:
    cmd = [
        "tesseract",
        str(image_path),
        "stdout",
        "-l", LANG,
        "--psm", PSM,
        "-c", "preserve_interword_spaces=1",
    ]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return normalize_text(result.stdout)


def process_image(image_path: Path) -> dict:
    lines = run_tesseract(image_path)
    combined_text = "\n".join(lines)
    return {
        "relativePath": image_path.relative_to(PROJECT_ROOT).as_posix(),
        "fileName": image_path.name,
        "category": image_path.parent.name,
        "titleLines": [],
        "bodyLines": [],
        "fullLines": lines,
        "titleText": "",
        "bodyText": "",
        "fullText": combined_text,
        "combinedText": combined_text,
    }


def write_outputs(cards: list[dict]) -> None:
    generated_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "generatedAt": generated_at,
        "projectRoot": str(PROJECT_ROOT),
        "seasonalRoot": str(SEASONAL_ROOT),
        "imageCount": len(cards),
        "engine": "tesseract",
        "language": LANG,
        "psm": PSM,
        "mode": "full-image-only",
        "cards": cards,
    }
    OUTPUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        f"Generated: {generated_at}",
        f"Seasonal Root: {SEASONAL_ROOT}",
        f"Image Count: {len(cards)}",
        "Engine: tesseract",
        f"Language: {LANG}",
        f"PSM: {PSM}",
        "Mode: full-image-only",
        "",
    ]
    for card in cards:
        lines.append(f"=== {card['relativePath']} ===")
        lines.append(card["combinedText"] or "(none)")
        lines.append("")
    OUTPUT_TEXT.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    image_paths = sorted(SEASONAL_ROOT.glob("**/*.png"))
    cards = [process_image(image_path) for image_path in image_paths]
    write_outputs(cards)
    print(OUTPUT_JSON)
    print(OUTPUT_TEXT)
    print(f"Processed {len(image_paths)} seasonal card images")


if __name__ == "__main__":
    main()
