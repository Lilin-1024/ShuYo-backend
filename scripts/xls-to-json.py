#!/usr/bin/env python3
"""Converts the school's course list (.xls, Excel 97) to JSON rows for import-course-catalog.js.

Requires xlrd 2.x:  python3 -m venv /tmp/xlsenv && /tmp/xlsenv/bin/pip install xlrd
Usage:              /tmp/xlsenv/bin/python scripts/xls-to-json.py 课程一览.xls > catalog.json
"""
import json
import sys

import xlrd


def cell_text(cell):
    if cell.ctype == xlrd.XL_CELL_NUMBER:
        value = cell.value
        return str(int(value)) if float(value).is_integer() else str(value)
    return str(cell.value).strip()


def main():
    if len(sys.argv) != 2:
        sys.stderr.write('用法：python scripts/xls-to-json.py <课程一览.xls>\n')
        sys.exit(2)
    sheet = xlrd.open_workbook(sys.argv[1]).sheet_by_index(0)
    header = [cell_text(cell) for cell in sheet.row(0)]
    if '课程号' not in header or '上课教师工号' not in header:
        sys.stderr.write('第一行不是课程一览表头。\n')
        sys.exit(1)
    rows = []
    for index in range(1, sheet.nrows):
        values = [cell_text(cell) for cell in sheet.row(index)]
        if any(values):
            rows.append(dict(zip(header, values)))
    json.dump(rows, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
