"""
เทรนโมเดลทำนายโอกาสการเกิดอุบัติเหตุบนถนน ระดับ จังหวัด x วัน

อ่าน data/processed/panel.csv ที่สร้างจาก `npm run build`
แล้วเทรน 2 โมเดลต่อหนึ่ง algorithm:
  1. classifier  -> P(เกิดอุบัติเหตุอย่างน้อย 1 ครั้ง)   <- โมเดลหลัก
  2. Poisson     -> จำนวนครั้งที่คาดว่าจะเกิด             <- ใช้จัดลำดับความรุนแรง

รองรับทั้ง LightGBM และ XGBoost เพื่อเทียบกันบนเงื่อนไขเดียวกันทุกอย่าง
(feature ชุดเดียวกัน, การแบ่งข้อมูลเดียวกัน, calibration และการเลือก threshold แบบเดียวกัน)

    python train/train.py                    # เทรนทั้งสอง แล้วเทียบ
    python train/train.py --algo lightgbm    # เฉพาะ LightGBM
    python train/train.py --algo xgboost     # เฉพาะ XGBoost

การแบ่งข้อมูลใช้เวลาเป็นเกณฑ์เสมอ ห้าม shuffle เพราะเป็นอนุกรมเวลา
ถ้าสุ่มแบ่ง โมเดลจะได้เห็นอนาคตแล้ววัดผลออกมาสวยเกินจริง
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
import lightgbm as lgb
import xgboost as xgb
import matplotlib

matplotlib.use("Agg")
# ฟอนต์ตั้งต้นของ matplotlib (DejaVu Sans) ไม่มีอักษรไทย จะขึ้นเป็นสี่เหลี่ยมโหว่
# Tahoma / Leelawadee UI มีมากับ Windows และรองรับไทย
matplotlib.rcParams["font.family"] = ["Tahoma", "Leelawadee UI", "DejaVu Sans"]
matplotlib.rcParams["axes.unicode_minus"] = False
import matplotlib.pyplot as plt

from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    mean_poisson_deviance,
    precision_score,
    recall_score,
    roc_auc_score,
)

ROOT = Path(__file__).resolve().parent.parent
PANEL = ROOT / "data" / "processed" / "panel.csv"
SPEC = ROOT / "data" / "processed" / "feature_spec.json"
ARTIFACTS = ROOT / "train" / "artifacts"

# แบ่งตามปีปฏิทิน (ค.ศ.)
# ใช้ 2025 เต็มปีเป็น test เพื่อให้ชุดทดสอบครอบคลุมทั้งสงกรานต์และปีใหม่
# ถ้าใช้ 2026 เป็น test จะเหลือแค่ ม.ค.-เม.ย. ซึ่งวัดผล feature เทศกาลไม่ได้เลย
SPLITS = {
    "train": (2022, 2023),
    "valid": (2024, 2024),
    "test": (2025, 2025),
    "holdout": (2026, 2026),
}

# ตั้งค่าให้สองฝั่งมีความจุใกล้เคียงกันที่สุด เพื่อให้เทียบกันได้อย่างเป็นธรรม
# LightGBM โตต้นไม้แบบ leaf-wise (คุมด้วย num_leaves) ส่วน XGBoost โตแบบ level-wise (คุมด้วย max_depth)
# num_leaves=63 กับ max_depth=6 ให้จำนวนใบสูงสุดเท่ากันคือ 64
COMMON = dict(n_estimators=2000, learning_rate=0.03, subsample=0.8, colsample_bytree=0.8)
EARLY_STOPPING_ROUNDS = 100
SEED = 42

# จัดกลุ่ม feature ตาม 4 ด้านที่เป็นโจทย์ตั้งต้นของโปรเจกต์ (+ กลุ่มพื้นฐานอีก 2)
# ใช้รวมค่า SHAP เพื่อตอบว่า "อากาศ/เทศกาล/ลักษณะทาง มีน้ำหนักด้านละกี่ %"
FEATURE_GROUPS = {
    "ประวัติอุบัติเหตุ": ["acc_roll7_prev", "acc_roll28_prev", "acc_same_dow_mean_prev"],
    "เทศกาล/วันหยุด": [
        "is_public_holiday", "is_observance", "is_holiday_eve", "is_songkran", "is_newyear",
        "is_seven_dangerous_days", "day_off_run_length", "is_long_weekend",
        "days_to_next_holiday", "days_since_prev_holiday", "is_weekend",
    ],
    "สภาพอากาศ": [
        "precip_mm", "rain_mm", "precip_hours", "temp_max", "temp_min", "wind_max",
        "is_rainy", "is_heavy_rain", "rain_lag1", "rain_3d_sum",
    ],
    "ลักษณะเส้นทาง": [
        "highway_km", "vehicle_km", "avg_lanes", "road_km_per_area",
        "pct_curve_prev", "pct_slope_prev", "pct_junction_prev",
        "osm_motorway_ways", "osm_trunk_ways", "osm_primary_ways",
        "osm_secondary_ways", "osm_traffic_signals",
    ],
    "การเปิดรับความเสี่ยง": [
        "population", "area_km2", "log_population", "motorcycle_per_capita", "vehicle_density",
    ],
    "เวลา/ฤดูกาล": ["dow", "month", "doy_sin", "doy_cos", "days_since_start"],
}


def group_of(feature: str) -> str:
    for name, members in FEATURE_GROUPS.items():
        if feature in members:
            return name
    # ถ้า feature ใหม่ถูกเพิ่มใน panel แล้วลืมจัดกลุ่ม % จะผิดโดยไม่มีใครรู้ จึงต้องล้มดัง
    raise KeyError(
        f"feature '{feature}' ยังไม่ถูกจัดกลุ่มใน FEATURE_GROUPS — "
        f"เพิ่มเข้ากลุ่มที่เหมาะสมก่อน ไม่งั้นสัดส่วน % จะคลาดเคลื่อน"
    )


def build_classifier(algo: str):
    if algo == "lightgbm":
        return lgb.LGBMClassifier(
            objective="binary",
            num_leaves=63,
            min_child_samples=40,
            subsample_freq=1,  # LightGBM ต้องสั่งให้ subsample ทำงานจริง ไม่งั้นถูกเมิน
            reg_lambda=1.0,
            random_state=SEED,
            n_jobs=-1,
            verbose=-1,
            **COMMON,
        )
    return xgb.XGBClassifier(
        objective="binary:logistic",
        eval_metric="aucpr",
        max_depth=6,
        min_child_weight=10,
        reg_lambda=1.0,
        tree_method="hist",
        early_stopping_rounds=EARLY_STOPPING_ROUNDS,
        random_state=SEED,
        n_jobs=-1,
        **COMMON,
    )


def build_regressor(algo: str):
    if algo == "lightgbm":
        return lgb.LGBMRegressor(
            objective="poisson",
            num_leaves=63,
            min_child_samples=40,
            subsample_freq=1,
            random_state=SEED,
            n_jobs=-1,
            verbose=-1,
            **COMMON,
        )
    return xgb.XGBRegressor(
        objective="count:poisson",
        eval_metric="poisson-nloglik",
        max_depth=6,
        min_child_weight=10,
        tree_method="hist",
        early_stopping_rounds=EARLY_STOPPING_ROUNDS,
        random_state=SEED,
        n_jobs=-1,
        **COMMON,
    )


def fit_model(model, algo: str, X, y, X_valid, y_valid):
    """LightGBM สั่ง early stopping ผ่าน callback ส่วน XGBoost สั่งตอนสร้าง object"""
    if algo == "lightgbm":
        model.fit(
            X, y,
            eval_set=[(X_valid, y_valid)],
            callbacks=[lgb.early_stopping(EARLY_STOPPING_ROUNDS, verbose=False)],
        )
    else:
        model.fit(X, y, eval_set=[(X_valid, y_valid)], verbose=False)
    return model


def best_iteration(model, algo: str) -> int:
    value = model.best_iteration_ if algo == "lightgbm" else model.best_iteration
    return int(value) if value is not None else -1


def load_panel() -> tuple[pd.DataFrame, dict]:
    if not PANEL.exists():
        raise SystemExit(f"ไม่พบ {PANEL}\nรัน `npm run build` ก่อน")
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    df = pd.read_csv(PANEL, parse_dates=["date"])
    df = df.sort_values(["date", "geocode"]).reset_index(drop=True)
    return df, spec


def pick_features(df: pd.DataFrame, spec: dict) -> list[str]:
    excluded = set(spec["exclude_from_features"])
    features = []
    for col in df.columns:
        if col in excluded:
            continue
        if not pd.api.types.is_numeric_dtype(df[col]):
            continue
        # คอลัมน์ที่ว่างทั้งหมด (เช่น osm_* ตอนรันแบบ --skip-osm) ไม่มีประโยชน์
        if df[col].notna().sum() == 0:
            continue
        features.append(col)
    return features


def split_frame(df: pd.DataFrame, name: str) -> pd.DataFrame:
    lo, hi = SPLITS[name]
    return df[(df["year"] >= lo) & (df["year"] <= hi)]


def baselines(train: pd.DataFrame, target: pd.DataFrame) -> dict[str, np.ndarray]:
    """
    เกณฑ์เปรียบเทียบที่ต้องเอาชนะให้ได้ ไม่งั้นโมเดลก็ไม่ได้เพิ่มคุณค่าอะไร
    - province: อัตราการเกิดเหตุเฉลี่ยของจังหวัดนั้น
    - province x dow: เฉลี่ยของจังหวัดนั้นแยกตามวันในสัปดาห์
    """
    overall = train["y_accident"].mean()

    by_province = train.groupby("geocode")["y_accident"].mean()
    by_province_dow = train.groupby(["geocode", "dow"])["y_accident"].mean()

    p_province = target["geocode"].map(by_province).fillna(overall).to_numpy()
    keys = list(zip(target["geocode"], target["dow"]))
    p_province_dow = np.array([by_province_dow.get(k, overall) for k in keys])

    return {"baseline_province": p_province, "baseline_province_dow": p_province_dow}


def evaluate_binary(y_true: np.ndarray, p: np.ndarray, threshold: float = 0.5) -> dict:
    """
    metric ที่ไม่ขึ้นกับ threshold (AUC, Brier) + metric ที่ขึ้นกับ threshold (F1, accuracy)

    ข้อมูลชุดนี้ positive ~44% ซึ่งไม่ได้เบ้จัด แต่ threshold 0.5 ก็ยังไม่ใช่จุดที่ดีที่สุดเสมอไป
    จึงรายงานทั้งที่ 0.5 และที่จุดซึ่ง F1 สูงสุด (เลือกจากชุด valid เท่านั้น ไม่แอบดู test)
    """
    pred = (p >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, pred, labels=[0, 1]).ravel()
    return {
        "roc_auc": float(roc_auc_score(y_true, p)),
        "pr_auc": float(average_precision_score(y_true, p)),
        "brier": float(brier_score_loss(y_true, p)),
        "threshold": float(threshold),
        "accuracy": float(accuracy_score(y_true, pred)),
        "precision": float(precision_score(y_true, pred, zero_division=0)),
        "recall": float(recall_score(y_true, pred, zero_division=0)),
        "f1": float(f1_score(y_true, pred, zero_division=0)),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def best_f1_threshold(y_true: np.ndarray, p: np.ndarray) -> float:
    """หา threshold ที่ให้ F1 สูงสุด — ต้องเรียกบนชุด valid เท่านั้น"""
    best_t, best_f1 = 0.5, -1.0
    for t in np.arange(0.05, 0.96, 0.01):
        score = f1_score(y_true, (p >= t).astype(int), zero_division=0)
        if score > best_f1:
            best_f1, best_t = score, float(t)
    return best_t


def plot_calibration(y_true: np.ndarray, p: np.ndarray, path: Path) -> None:
    bins = np.linspace(0, 1, 11)
    idx = np.digitize(p, bins) - 1
    xs, ys = [], []
    for b in range(10):
        mask = idx == b
        if mask.sum() < 20:
            continue
        xs.append(p[mask].mean())
        ys.append(y_true[mask].mean())

    plt.figure(figsize=(5, 5))
    plt.plot([0, 1], [0, 1], "--", color="gray", label="สมบูรณ์แบบ")
    plt.plot(xs, ys, "o-", label="โมเดล")
    plt.xlabel("ความน่าจะเป็นที่ทำนาย")
    plt.ylabel("อัตราที่เกิดจริง")
    plt.title("Calibration curve (test)")
    plt.legend()
    plt.tight_layout()
    plt.savefig(path, dpi=120)
    plt.close()


def plot_shap_groups(by_group: dict, path: Path) -> None:
    """แท่งเทียบน้ำหนักของแต่ละกลุ่ม — ตอบโจทย์ตั้งต้นของโปรเจกต์ในรูปเดียว"""
    items = sorted(by_group.items(), key=lambda kv: kv[1]["percent"])
    labels = [k for k, _ in items]
    values = [v["percent"] for _, v in items]

    plt.figure(figsize=(8, 4.5))
    bars = plt.barh(labels, values, color="#4C78A8")
    for bar, value in zip(bars, values):
        plt.text(value + 0.6, bar.get_y() + bar.get_height() / 2,
                 f"{value:.1f}%", va="center", fontsize=9)
    plt.xlabel("สัดส่วนของ mean |SHAP| (%)")
    plt.title("น้ำหนักของข้อมูลแต่ละด้านต่อการทำนาย")
    plt.xlim(0, max(values) * 1.18)
    plt.tight_layout()
    plt.savefig(path, dpi=120)
    plt.close()


def plot_dependence(feature: str, values: np.ndarray, shap_col: np.ndarray,
                    title: str, xlabel: str, path: Path) -> None:
    """
    ค่า feature เทียบกับ SHAP ของมัน — บอกว่าความสัมพันธ์เป็นแบบไหน
    เช่น ฝนตกกี่มิลถึงเริ่มดันความเสี่ยงขึ้น และขึ้นแบบเชิงเส้นหรือมีจุดหักศอก
    """
    plt.figure(figsize=(7, 4.5))
    plt.axhline(0, color="gray", linewidth=0.8, linestyle="--")
    plt.scatter(values, shap_col, s=6, alpha=0.25, color="#4C78A8", edgecolors="none")

    # เส้นค่าเฉลี่ย ช่วยให้เห็นแนวโน้มท่ามกลางจุดกระจาย
    # feature ที่มีค่าไม่ต่อเนื่อง (เช่น จำนวนวันหยุด 0-5) ต้องเฉลี่ยทีละค่า
    # ถ้าใช้ quantile จะกระจุกอยู่ที่ค่าที่พบบ่อย แล้วเส้นไม่ลากไปถึงช่วงที่น่าสนใจ
    uniques = np.unique(values[~np.isnan(values)])
    xs, ys = [], []
    if len(uniques) <= 25:
        for u in uniques:
            mask = values == u
            if mask.sum() >= 20:
                xs.append(float(u))
                ys.append(float(shap_col[mask].mean()))
    else:
        edges = np.unique(np.quantile(values, np.linspace(0, 1, 26)))
        for lo, hi in zip(edges[:-1], edges[1:]):
            mask = (values >= lo) & (values <= hi)
            if mask.sum() >= 20:
                xs.append(float(values[mask].mean()))
                ys.append(float(shap_col[mask].mean()))

    if xs:
        plt.plot(xs, ys, "o-", color="#E45756", linewidth=2, markersize=5, label="ค่าเฉลี่ย")
        plt.legend()

    plt.xlabel(xlabel)
    plt.ylabel(f"SHAP ของ {feature} (log-odds)")
    plt.title(title)
    plt.tight_layout()
    plt.savefig(path, dpi=120)
    plt.close()


def run_shap(clf, test: pd.DataFrame, features: list[str], out_dir: Path) -> dict:
    """
    วิเคราะห์ SHAP ของ classifier แล้วคืนตัวเลขที่เทียบข้าม algorithm ได้

    ทำไมต้องใช้ SHAP แทน feature_importances_ ของ library:
    LightGBM รายงานเป็น split count ส่วน XGBoost รายงานเป็น gain — คนละหน่วยกัน
    เทียบข้ามกันไม่ได้เลย ส่วน SHAP อยู่ในหน่วย log-odds เหมือนกันทั้งคู่
    """
    try:
        import shap
    except ImportError as err:
        print(f"ข้าม SHAP: {err}")
        return {}

    X = test[features]
    values = shap.TreeExplainer(clf).shap_values(X)
    if isinstance(values, list):  # shap เวอร์ชันเก่าคืน list ต่อ class
        values = values[1]
    if values.ndim == 3:  # เวอร์ชันใหม่บางกรณีคืน (n, features, classes)
        values = values[:, :, -1]

    mean_abs = np.abs(values).mean(axis=0)
    total = float(mean_abs.sum())

    per_feature = {
        feat: {"mean_abs_shap": float(v), "percent": float(100 * v / total)}
        for feat, v in sorted(zip(features, mean_abs), key=lambda kv: kv[1], reverse=True)
    }

    by_group: dict[str, dict] = {}
    for feat, v in zip(features, mean_abs):
        entry = by_group.setdefault(group_of(feat), {"mean_abs_shap": 0.0, "features": []})
        entry["mean_abs_shap"] += float(v)
        entry["features"].append(feat)
    for entry in by_group.values():
        entry["percent"] = float(100 * entry["mean_abs_shap"] / total)
    by_group = dict(sorted(by_group.items(), key=lambda kv: kv[1]["percent"], reverse=True))

    # ตรวจว่าไม่มี feature ตกหล่นจากการจัดกลุ่ม ไม่งั้น % ที่รายงานจะผิด
    grouped_pct = sum(e["percent"] for e in by_group.values())
    if abs(grouped_pct - 100.0) > 0.01:
        raise ValueError(f"สัดส่วนกลุ่มรวมได้ {grouped_pct:.4f}% ไม่ใช่ 100% — มี feature ตกหล่น")

    print("\nน้ำหนักตามกลุ่มข้อมูล (จาก mean |SHAP| บนชุด test):")
    for name, entry in by_group.items():
        print(f"  {name:22s} {entry['percent']:5.1f}%   ({len(entry['features'])} feature)")

    print("\nfeature ที่มีผลมากสุด 10 อันดับ (mean |SHAP|):")
    for feat, entry in list(per_feature.items())[:10]:
        print(f"  {feat:30s} {entry['mean_abs_shap']:.4f}  ({entry['percent']:4.1f}%)")

    # ---------- กราฟ ----------
    plot_shap_groups(by_group, out_dir / "shap_groups.png")

    sample_idx = np.random.default_rng(SEED).choice(
        len(X), size=min(4000, len(X)), replace=False
    )
    plt.figure()
    shap.summary_plot(values[sample_idx], X.iloc[sample_idx], show=False, max_display=20)
    plt.tight_layout()
    plt.savefig(out_dir / "shap_summary.png", dpi=120)
    plt.close()

    for feat, fname, title, xlabel in [
        ("precip_mm", "shap_dependence_rain.png",
         "ฝนตกเท่าไรถึงดันความเสี่ยงขึ้น", "ปริมาณฝน (มม./วัน)"),
        ("day_off_run_length", "shap_dependence_festival.png",
         "วันหยุดยิ่งยาว ความเสี่ยงยิ่งสูงไหม", "ความยาวช่วงวันหยุดต่อเนื่อง (วัน)"),
    ]:
        if feat in features:
            col = features.index(feat)
            plot_dependence(feat, X[feat].to_numpy(), values[:, col],
                            title, xlabel, out_dir / fname)

    return {"rows_analysed": int(len(X)), "by_group": by_group, "per_feature": per_feature}


def save_model(model, algo: str, path_stem: Path) -> None:
    if algo == "lightgbm":
        model.booster_.save_model(str(path_stem.with_suffix(".txt")))
    else:
        model.get_booster().save_model(str(path_stem.with_suffix(".json")))


def run_algo(algo: str, data: dict, features: list[str]) -> dict:
    """เทรนทั้ง classifier และ Poisson ของ algorithm หนึ่ง แล้วคืน metrics"""
    train, valid, test, holdout = data["train"], data["valid"], data["test"], data["holdout"]
    out_dir = ARTIFACTS / algo
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'=' * 68}\n{algo.upper()}\n{'=' * 68}")

    # ---------- โมเดลหลัก: classifier ----------
    clf = fit_model(
        build_classifier(algo), algo,
        train[features], train["y_accident"],
        valid[features], valid["y_accident"],
    )
    n_trees = best_iteration(clf, algo)
    print(f"best_iteration: {n_trees} (จากเพดาน {COMMON['n_estimators']})")

    # ปรับความน่าจะเป็นด้วย isotonic บนชุด valid
    # ค่าดิบจาก GBM มักเบ้ ทำให้ตัวเลข "โอกาสเกิด" เอาไปสื่อสารกับคนไม่ได้ตรง ๆ
    raw_valid = clf.predict_proba(valid[features])[:, 1]
    calibrator = IsotonicRegression(out_of_bounds="clip")
    calibrator.fit(raw_valid, valid["y_accident"])

    # เลือก threshold จากชุด valid เท่านั้น แล้วเอาไปใช้กับ test/holdout แบบตายตัว
    # ถ้าไปจูน threshold บน test จะเป็นการแอบดูเฉลย ตัวเลขจะสวยเกินจริง
    cal_valid = calibrator.predict(raw_valid)
    tuned_threshold = best_f1_threshold(valid["y_accident"].to_numpy(), cal_valid)
    print(f"threshold ที่ให้ F1 สูงสุดบนชุด valid: {tuned_threshold:.2f}")

    results = {
        "algo": algo,
        "n_features": len(features),
        "best_iteration": n_trees,
        "tuned_threshold": tuned_threshold,
        "splits": {},
    }

    for name, frame in [("valid", valid), ("test", test), ("holdout", holdout)]:
        if len(frame) == 0:
            continue
        y = frame["y_accident"].to_numpy()
        cal = calibrator.predict(clf.predict_proba(frame[features])[:, 1])

        entry = {
            "rows": int(len(frame)),
            "positive_rate": float(y.mean()),
            "model_at_0.5": evaluate_binary(y, cal, 0.5),
            "model_at_tuned": evaluate_binary(y, cal, tuned_threshold),
        }
        for bname, bp in baselines(train, frame).items():
            entry[bname] = evaluate_binary(y, bp, 0.5)
        results["splits"][name] = entry

        m5, mt = entry["model_at_0.5"], entry["model_at_tuned"]
        print(f"\n[{name}] n={len(frame):,} สัดส่วนวันที่เกิดเหตุจริง={y.mean():.3f}")
        print(f"  ไม่ขึ้นกับ threshold : ROC-AUC={m5['roc_auc']:.4f}  PR-AUC={m5['pr_auc']:.4f}  Brier={m5['brier']:.4f}")
        print(f"  @0.50  acc={m5['accuracy']:.4f}  P={m5['precision']:.4f}  R={m5['recall']:.4f}  F1={m5['f1']:.4f}")
        print(f"  @{tuned_threshold:.2f}  acc={mt['accuracy']:.4f}  P={mt['precision']:.4f}  R={mt['recall']:.4f}  F1={mt['f1']:.4f}")
        c = mt["confusion"]
        print(f"         confusion @{tuned_threshold:.2f}: TP={c['tp']:,} FP={c['fp']:,} FN={c['fn']:,} TN={c['tn']:,}")

    test_entry = results["splits"]["test"]
    beat = test_entry["model_at_0.5"]["pr_auc"] > test_entry["baseline_province_dow"]["pr_auc"]
    results["beats_baseline"] = bool(beat)
    print(f"\nชนะ baseline จังหวัดxdow บนชุด test: {'ใช่' if beat else 'ไม่'}")

    plot_calibration(
        test["y_accident"].to_numpy(),
        calibrator.predict(clf.predict_proba(test[features])[:, 1]),
        out_dir / "calibration.png",
    )

    # ---------- โมเดลรอง: จำนวนครั้ง (Poisson) ----------
    reg = fit_model(
        build_regressor(algo), algo,
        train[features], train["y_accident_count"],
        valid[features], valid["y_accident_count"],
    )
    pred_count = np.clip(reg.predict(test[features]), 1e-6, None)
    results["count_model"] = {
        "best_iteration": best_iteration(reg, algo),
        "test_poisson_deviance": float(mean_poisson_deviance(test["y_accident_count"], pred_count)),
        "test_mae": float(np.abs(test["y_accident_count"] - pred_count).mean()),
        "baseline_mae": float(
            np.abs(test["y_accident_count"] - train["y_accident_count"].mean()).mean()
        ),
    }
    print(f"\nโมเดลจำนวนครั้ง MAE={results['count_model']['test_mae']:.3f} "
          f"(baseline {results['count_model']['baseline_mae']:.3f})")

    # ---------- ความสำคัญของ feature ----------
    # LightGBM นับจำนวนครั้งที่ feature ถูกใช้ split ส่วน XGBoost ใช้ gain เป็นค่าตั้งต้น
    # สเกลจึงเทียบกันข้าม algorithm ตรง ๆ ไม่ได้ ดูได้แค่ "ลำดับ" ภายในแต่ละตัว
    importance = pd.Series(clf.feature_importances_, index=features).sort_values(ascending=False)
    results["top_features"] = {k: float(v) for k, v in importance.head(25).items()}
    print("\nfeature ที่มีผลมากสุด 10 อันดับ:")
    for feat, val in importance.head(10).items():
        print(f"  {feat:32s} {val:.4g}")

    results["shap"] = run_shap(clf, test, features, out_dir)

    save_model(clf, algo, out_dir / "model_binary")
    save_model(reg, algo, out_dir / "model_count")
    np.save(out_dir / "calibrator_x.npy", calibrator.X_thresholds_)
    np.save(out_dir / "calibrator_y.npy", calibrator.y_thresholds_)
    (out_dir / "metrics.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out_dir / "features.json").write_text(
        json.dumps(features, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return results


def print_comparison(all_results: dict[str, dict]) -> None:
    print(f"\n{'=' * 78}\nเทียบผลบนชุด test (เงื่อนไขเดียวกันทุกอย่าง)\n{'=' * 78}")
    header = f"{'':<26}" + "".join(f"{a:>17}" for a in all_results)
    print(header)

    rows = [
        ("ROC-AUC", lambda r: r["splits"]["test"]["model_at_0.5"]["roc_auc"]),
        ("PR-AUC", lambda r: r["splits"]["test"]["model_at_0.5"]["pr_auc"]),
        ("Brier (ต่ำ=ดี)", lambda r: r["splits"]["test"]["model_at_0.5"]["brier"]),
        ("accuracy @0.50", lambda r: r["splits"]["test"]["model_at_0.5"]["accuracy"]),
        ("F1 @0.50", lambda r: r["splits"]["test"]["model_at_0.5"]["f1"]),
        ("F1 @threshold ที่จูน", lambda r: r["splits"]["test"]["model_at_tuned"]["f1"]),
        ("F1 holdout 2026", lambda r: r["splits"]["holdout"]["model_at_tuned"]["f1"]),
        ("MAE จำนวนครั้ง (ต่ำ=ดี)", lambda r: r["count_model"]["test_mae"]),
    ]
    for label, getter in rows:
        line = f"{label:<26}"
        values = {a: getter(r) for a, r in all_results.items()}
        lower_is_better = "ต่ำ=ดี" in label
        best = min(values.values()) if lower_is_better else max(values.values())
        for a in all_results:
            mark = " *" if abs(values[a] - best) < 1e-12 else "  "
            line += f"{values[a]:>15.4f}{mark}"
        print(line)

    line = f"{'จำนวนต้นไม้ที่ใช้จริง':<26}"
    for a, r in all_results.items():
        line += f"{r['best_iteration']:>15d}  "
    print(line)
    print("\n* = ดีกว่าในแถวนั้น")

    # เทียบน้ำหนักตามกลุ่มข้อมูล — mean|SHAP| เทียบข้าม algorithm ได้จริง
    # ต่างจาก feature_importances_ ที่ LightGBM ใช้ split count ส่วน XGBoost ใช้ gain
    if all("shap" in r and r["shap"] for r in all_results.values()):
        print(f"\n{'=' * 78}\nน้ำหนักตามกลุ่มข้อมูล — % ของ mean |SHAP| (เทียบข้าม algorithm ได้)\n{'=' * 78}")
        print(f"{'':<26}" + "".join(f"{a:>17}" for a in all_results))
        groups = list(next(iter(all_results.values()))["shap"]["by_group"])
        for g in groups:
            line = f"{g:<26}"
            for r in all_results.values():
                line += f"{r['shap']['by_group'][g]['percent']:>14.1f}%  "
            print(line)

        # ดูความสอดคล้อง 2 มิติ: ส่วนต่างรายกลุ่ม และลำดับความสำคัญโดยรวม
        # ส่วนต่างรายกลุ่มเดียวสูงไม่ได้แปลว่าสรุปไม่ได้ ถ้าลำดับยังตรงกัน
        spreads = {
            g: max(r["shap"]["by_group"][g]["percent"] for r in all_results.values())
            - min(r["shap"]["by_group"][g]["percent"] for r in all_results.values())
            for g in groups
        }
        worst_group = max(spreads, key=spreads.get)
        rankings = [
            sorted(groups, key=lambda g: r["shap"]["by_group"][g]["percent"], reverse=True)
            for r in all_results.values()
        ]
        same_rank = all(rank == rankings[0] for rank in rankings)

        print(f"\nส่วนต่างมากสุดอยู่ที่กลุ่ม '{worst_group}' = {spreads[worst_group]:.1f} จุด")
        print(f"กลุ่มที่เหลือต่างกัน {max(v for g, v in spreads.items() if g != worst_group):.1f} จุดหรือน้อยกว่า")
        print(f"ลำดับความสำคัญของทั้งสอง algorithm: {'ตรงกันทุกอันดับ' if same_rank else 'สลับกันบางอันดับ'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--algo", choices=["lightgbm", "xgboost", "both"], default="both",
        help="เลือก algorithm (ค่าตั้งต้นคือเทรนทั้งสองแล้วเทียบ)",
    )
    args = parser.parse_args()

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    df, spec = load_panel()
    features = pick_features(df, spec)

    data = {name: split_frame(df, name) for name in SPLITS}
    print(f"features: {len(features)}")
    print("  ".join(f"{k} {len(v):,}" for k, v in data.items()))
    print(f"อัตราการเกิดเหตุใน train: {data['train']['y_accident'].mean():.3f}")

    if any(len(data[k]) == 0 for k in ("train", "valid", "test")):
        raise SystemExit("ชุดข้อมูลบางส่วนว่าง — ตรวจช่วงปีใน SPLITS กับข้อมูลจริง")

    algos = ["lightgbm", "xgboost"] if args.algo == "both" else [args.algo]
    all_results = {algo: run_algo(algo, data, features) for algo in algos}

    if len(all_results) > 1:
        print_comparison(all_results)

    summary = {
        "features": features,
        "n_features": len(features),
        "algorithms": {a: r for a, r in all_results.items()},
    }
    (ARTIFACTS / "comparison.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nเซฟผลลัพธ์ลง {ARTIFACTS} (แยกโฟลเดอร์ตาม algorithm)")


if __name__ == "__main__":
    main()
