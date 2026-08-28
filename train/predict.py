"""
ทำนายโอกาสเกิดอุบัติเหตุของจังหวัดหนึ่งในวันหนึ่ง จากโมเดลที่เทรนไว้แล้ว

ตัวอย่าง:
    python train/predict.py --province เชียงใหม่ --date 2025-04-13
    python train/predict.py --geocode 50 --date 2025-04-13 --explain

หมายเหตุ: สคริปต์นี้ดึงแถวจาก panel.csv ที่สร้างไว้แล้ว จึงทำนายได้เฉพาะวันที่อยู่ในชุดข้อมูล
ถ้าจะทำนายอนาคตจริง ต้องเตรียมฟีเจอร์ของวันนั้นเอง (พยากรณ์อากาศ + ปฏิทินวันหยุด)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# console ของ Windows ใช้ codepage เก่า ทำให้ข้อความไทยออกมาเป็นตัวยึกยือ
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import pandas as pd

# lightgbm / xgboost ถูก import ข้างในฟังก์ชัน จะได้โหลดเฉพาะตัวที่ใช้จริง

ROOT = Path(__file__).resolve().parent.parent
PANEL = ROOT / "data" / "processed" / "panel.csv"
ARTIFACTS = ROOT / "train" / "artifacts"


def load_calibrator(model_dir: Path):
    xs = np.load(model_dir / "calibrator_x.npy")
    ys = np.load(model_dir / "calibrator_y.npy")
    return lambda p: np.interp(p, xs, ys)


def load_boosters(model_dir: Path, algo: str):
    """LightGBM เซฟเป็น .txt ส่วน XGBoost เซฟเป็น .json — โหลดคนละแบบกัน"""
    if algo == "lightgbm":
        import lightgbm as lgb

        return (
            lgb.Booster(model_file=str(model_dir / "model_binary.txt")),
            lgb.Booster(model_file=str(model_dir / "model_count.txt")),
        )

    import xgboost as xgb

    clf, reg = xgb.Booster(), xgb.Booster()
    clf.load_model(str(model_dir / "model_binary.json"))
    reg.load_model(str(model_dir / "model_count.json"))
    return clf, reg


def predict_proba(booster, algo: str, frame):
    if algo == "lightgbm":
        return booster.predict(frame)
    import xgboost as xgb

    return booster.predict(xgb.DMatrix(frame))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--province", help="ชื่อจังหวัดภาษาไทย")
    parser.add_argument("--geocode", help="รหัสจังหวัด 2 หลัก")
    parser.add_argument("--date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--explain", action="store_true", help="แสดง feature ที่ดันค่าขึ้น/ลง")
    parser.add_argument(
        "--algo", choices=["lightgbm", "xgboost"], default="xgboost",
        help="ใช้โมเดลจาก algorithm ไหน (ค่าตั้งต้น xgboost เพราะชนะบนชุด test เล็กน้อย)",
    )
    args = parser.parse_args()

    if not args.province and not args.geocode:
        raise SystemExit("ต้องระบุ --province หรือ --geocode อย่างน้อยหนึ่งอย่าง")

    model_dir = ARTIFACTS / args.algo
    if not (model_dir / "features.json").exists():
        raise SystemExit(f"ยังไม่มีโมเดลใน {model_dir} — รัน `python train/train.py` ก่อน")

    features = json.loads((model_dir / "features.json").read_text(encoding="utf-8"))
    booster, count_booster = load_boosters(model_dir, args.algo)
    calibrate = load_calibrator(model_dir)

    df = pd.read_csv(PANEL, parse_dates=["date"], dtype={"geocode": str})
    mask = df["date"] == pd.Timestamp(args.date)
    if args.province:
        mask &= df["province"] == args.province
    if args.geocode:
        mask &= df["geocode"] == str(args.geocode).zfill(2)

    row = df[mask]
    if row.empty:
        raise SystemExit(f"ไม่พบข้อมูลของวันที่/จังหวัดนี้ใน {PANEL.name}")
    row = row.iloc[[0]]

    raw = predict_proba(booster, args.algo, row[features])[0]
    prob = float(calibrate(raw))
    expected = float(np.clip(predict_proba(count_booster, args.algo, row[features])[0], 0, None))

    print(f"โมเดล   : {args.algo}")
    print(f"จังหวัด : {row['province'].iloc[0]}")
    print(f"วันที่   : {args.date}")
    print(f"โอกาสเกิดอุบัติเหตุ (อย่างน้อย 1 ครั้ง) : {prob:.1%}")
    print(f"จำนวนครั้งที่คาดว่าจะเกิด               : {expected:.2f}")
    print(f"เกิดขึ้นจริง                            : {int(row['y_accident_count'].iloc[0])} ครั้ง")

    context = []
    if row["is_songkran"].iloc[0] == 1:
        context.append("ช่วงสงกรานต์")
    if row["is_newyear"].iloc[0] == 1:
        context.append("ช่วงปีใหม่")
    if row["is_public_holiday"].iloc[0] == 1:
        context.append(f"วันหยุด: {row['holiday_name'].iloc[0]}")
    if row["is_rainy"].iloc[0] == 1:
        context.append(f"ฝนตก {row['precip_mm'].iloc[0]:.1f} มม.")
    if context:
        print("บริบท   : " + " | ".join(context))

    if args.explain:
        # ทั้งสอง library คืน contribution ต่อ feature + bias เป็นตัวสุดท้าย แต่เรียกคนละชื่อ
        if args.algo == "lightgbm":
            contrib = booster.predict(row[features], pred_contrib=True)[0]
        else:
            import xgboost as xgb

            contrib = booster.predict(xgb.DMatrix(row[features]), pred_contribs=True)[0]
        pairs = sorted(zip(features, contrib[:-1]), key=lambda kv: abs(kv[1]), reverse=True)
        print("\nปัจจัยที่มีผลมากสุด 10 อันดับ (+ ดันความเสี่ยงขึ้น / - ดันลง):")
        for feat, value in pairs[:10]:
            print(f"  {'+' if value > 0 else '-'} {feat:30s} {value:+.4f}")


if __name__ == "__main__":
    main()
