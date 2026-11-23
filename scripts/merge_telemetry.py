#!/usr/bin/env python3
"""실행 기록(텔레메트리) CSV 합치기 — 표준 라이브러리만, Python 3.8 이상.

친구들이 앱의 「실행 기록」 화면 → "기록 내보내기" 로 보내 준 CSV 를 한 파일로 합친다.

    python scripts/merge_telemetry.py <파일 또는 폴더 ...> [-o merged.csv]
                                     [--errors-out merged-errors.csv]
                                     [-r] [--excel]

- 폴더를 주면 그 안의 *.csv 를 읽는다(`-r` 이면 하위 폴더까지).
- 첫 줄(헤더)로 종류를 가른다.
    실행 기록   session_id,device_id,date,app_version,device_class,os,avg_fps,
                min_fps_1s,max_ram_mb,duration_min,error_count,crashed
    오류 종류   session_id,error_type,count       (telemetry-…-errors.csv)
  둘 다 아니면 경고하고 건너뛴다.
- 엑셀이 붙이는 BOM 이 있어도 읽는다(utf-8-sig).
- 같은 session_id 는 처음 것만 남긴다(오류 종류는 (session_id, error_type) 기준).
- 행마다 가볍게 검사한다 — date 는 YYYY-MM-DD, crashed 는 0/1, 숫자 칸은 숫자이거나 빈칸
  (avg_fps · min_fps_1s · max_ram_mb 는 잴 수 없으면 비어 있다). 틀린 행은 파일:줄 과 함께
  알리고 뺀다.
- 결과는 UTF-8(헤더 포함). `--excel` 이면 엑셀에서 한글이 깨지지 않게 BOM 을 붙인다.
  오류 종류 결과는 기본으로 출력 파일 옆 `merged_telemetry_errors.csv`.
- 남은 실행 기록 행이 하나도 없으면 0 이 아닌 코드로 끝난다.
"""

import argparse
import csv
import datetime
import os
import sys
from collections import Counter
from pathlib import Path

TELEMETRY_HEADER = [
    "session_id", "device_id", "date", "app_version", "device_class", "os",
    "avg_fps", "min_fps_1s", "max_ram_mb", "duration_min", "error_count", "crashed",
]
ERRORS_HEADER = ["session_id", "error_type", "count"]

DEVICE_CLASSES = ["PC-저사양", "PC-고사양", "모바일-보급형", "모바일-고급형"]
# 비어 있어도 되는 숫자 칸(잴 수 없는 환경) / 반드시 있어야 하는 숫자 칸
OPTIONAL_NUMBERS = ["avg_fps", "min_fps_1s", "max_ram_mb"]
REQUIRED_NUMBERS = ["duration_min", "error_count"]
REQUIRED_TEXT = ["session_id", "device_id", "app_version", "device_class", "os"]


def is_number(text):
    try:
        value = float(text)
    except ValueError:
        return False
    return value == value and value not in (float("inf"), float("-inf"))


def is_count(text):
    return text.isdigit()


def is_date(text):
    if len(text) != 10:
        return False
    try:
        datetime.date.fromisoformat(text)
    except ValueError:
        return False
    return True


def check_telemetry_row(row):
    """틀린 점을 문장으로 돌려준다. 맞으면 None."""
    for key in REQUIRED_TEXT:
        if not row[key]:
            return f"{key} 가 비어 있음"
    if not is_date(row["date"]):
        return f"date 가 YYYY-MM-DD 가 아님: {row['date']!r}"
    if row["crashed"] not in ("0", "1"):
        return f"crashed 가 0/1 이 아님: {row['crashed']!r}"
    for key in REQUIRED_NUMBERS:
        if not is_number(row[key]):
            return f"{key} 가 숫자가 아님: {row[key]!r}"
    if not is_count(row["error_count"]):
        return f"error_count 가 0 이상의 정수가 아님: {row['error_count']!r}"
    for key in OPTIONAL_NUMBERS:
        if row[key] and not is_number(row[key]):
            return f"{key} 가 숫자도 빈칸도 아님: {row[key]!r}"
    return None


def check_errors_row(row):
    if not row["session_id"]:
        return "session_id 가 비어 있음"
    if not row["error_type"]:
        return "error_type 이 비어 있음"
    if not is_count(row["count"]):
        return f"count 가 0 이상의 정수가 아님: {row['count']!r}"
    return None


def collect_files(inputs, recursive, outputs):
    """입력 인자를 CSV 파일 목록으로 푼다. 출력 파일 자신은 뺀다."""
    files = []
    seen = set()
    for item in inputs:
        path = Path(item)
        if path.is_dir():
            pattern = "**/*.csv" if recursive else "*.csv"
            found = sorted(p for p in path.glob(pattern) if p.is_file())
            if not found:
                print(f"경고: {path} 에 CSV 가 없음", file=sys.stderr)
        elif path.is_file():
            found = [path]
        else:
            print(f"경고: {path} 를 찾을 수 없음 — 건너뜀", file=sys.stderr)
            continue
        for p in found:
            key = os.path.normcase(str(p.resolve()))
            if key in seen or key in outputs:
                continue
            seen.add(key)
            files.append(p)
    return files


def read_csv(path):
    """(헤더, [(줄 번호, 행 리스트)]) — 읽지 못하면 예외."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        rows = []
        for row in reader:
            if not any(cell.strip() for cell in row):
                continue  # 빈 줄
            rows.append((reader.line_num, row))
    return header, rows


def write_csv(path, header, rows, excel):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig" if excel else "utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(header)
        for row in rows:
            writer.writerow([row[key] for key in header])


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="실행 기록(텔레메트리) CSV 를 하나로 합친다.",
    )
    parser.add_argument("inputs", nargs="+", help="CSV 파일 또는 폴더")
    parser.add_argument("-o", "--output", default="merged_telemetry.csv",
                        help="합친 실행 기록 (기본: merged_telemetry.csv)")
    parser.add_argument("--errors-out", default=None,
                        help="합친 오류 종류 (기본: 출력 옆 merged_telemetry_errors.csv)")
    parser.add_argument("-r", "--recursive", action="store_true", help="폴더의 하위 폴더까지 찾기")
    parser.add_argument("--excel", action="store_true",
                        help="엑셀에서 바로 열리도록 BOM 을 붙여 쓰기(utf-8-sig)")
    args = parser.parse_args(argv)

    output = Path(args.output)
    errors_out = Path(args.errors_out) if args.errors_out else output.with_name("merged_telemetry_errors.csv")
    outputs = {os.path.normcase(str(p.resolve())) for p in (output, errors_out)}

    files = collect_files(args.inputs, args.recursive, outputs)

    telemetry_files = 0
    errors_files = 0
    skipped_files = 0
    total_rows = 0
    dup_rows = 0
    invalid_rows = 0
    rows_out = []
    seen_sessions = set()

    err_total = 0
    err_dups = 0
    err_invalid = 0
    err_out = []
    seen_err = set()

    for path in files:
        try:
            header, rows = read_csv(path)
        except (OSError, UnicodeDecodeError, csv.Error) as exc:
            print(f"경고: {path} 를 읽지 못함 ({exc}) — 건너뜀", file=sys.stderr)
            skipped_files += 1
            continue
        header = [h.strip() for h in header] if header else []

        if header == TELEMETRY_HEADER:
            kind, columns, check = "telemetry", TELEMETRY_HEADER, check_telemetry_row
            telemetry_files += 1
        elif header == ERRORS_HEADER:
            kind, columns, check = "errors", ERRORS_HEADER, check_errors_row
            errors_files += 1
        else:
            print(f"경고: {path} 의 헤더가 실행 기록·오류 종류 어느 쪽도 아님 — 건너뜀", file=sys.stderr)
            skipped_files += 1
            continue

        for line, cells in rows:
            where = f"{path}:{line}"
            if kind == "telemetry":
                total_rows += 1
            else:
                err_total += 1
            if len(cells) != len(columns):
                problem = f"칸 수가 {len(cells)}개 (기대 {len(columns)}개)"
                row = None
            else:
                row = {key: cell.strip() for key, cell in zip(columns, cells)}
                problem = check(row)
            if problem:
                print(f"건너뜀: {where} — {problem}", file=sys.stderr)
                if kind == "telemetry":
                    invalid_rows += 1
                else:
                    err_invalid += 1
                continue

            if kind == "telemetry":
                if row["session_id"] in seen_sessions:
                    dup_rows += 1
                    continue
                seen_sessions.add(row["session_id"])
                rows_out.append(row)
            else:
                key = (row["session_id"], row["error_type"])
                if key in seen_err:
                    err_dups += 1
                    continue
                seen_err.add(key)
                err_out.append(row)

    if rows_out:
        write_csv(output, TELEMETRY_HEADER, rows_out, args.excel)
    if err_out:
        write_csv(errors_out, ERRORS_HEADER, err_out, args.excel)

    devices = {row["device_id"] for row in rows_out}
    by_class = Counter(row["device_class"] for row in rows_out)
    crashed = sum(int(row["crashed"]) for row in rows_out)

    print("== 실행 기록 합치기 ==")
    print(f"입력 파일 수     : {len(files)} (실행 기록 {telemetry_files} · 오류 종류 {errors_files} · 건너뜀 {skipped_files})")
    print(f"전체 행 수       : {total_rows}")
    print(f"중복 제거 수     : {dup_rows}")
    print(f"건너뛴 행 수     : {invalid_rows}")
    print(f"최종 행 수       : {len(rows_out)}")
    print(f"기기 수          : {len(devices)}")
    print("device_class별 행 수:")
    for name in DEVICE_CLASSES + sorted(set(by_class) - set(DEVICE_CLASSES)):
        mark = "" if name in DEVICE_CLASSES else "  (알 수 없는 분류)"
        print(f"  {name:<10} {by_class.get(name, 0)}{mark}")
    print(f"crashed 합계     : {crashed}")
    if errors_files:
        print(f"오류 종류        : 전체 {err_total} · 중복 {err_dups} · 건너뜀 {err_invalid} · 최종 {len(err_out)}")

    if not rows_out:
        print("남은 실행 기록 행이 없어 아무것도 쓰지 않았습니다.", file=sys.stderr)
        return 1
    print(f"저장: {output}")
    if err_out:
        print(f"저장: {errors_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
