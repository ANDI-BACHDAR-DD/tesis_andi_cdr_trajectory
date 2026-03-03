from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException, Request
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Dict, Any, Generator
import uuid
from datetime import datetime, timezone, timedelta
import openpyxl
import pandas as pd
import io
import json
import numpy as np
from tempfile import SpooledTemporaryFile

# Offline analysis imports
import math
from collections import Counter, defaultdict
import networkx as nx
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.cluster import DBSCAN
from dateutil import parser as dateparser
from haversine import haversine

# --------------------
# Configuration / Init
# --------------------
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# MongoDB connection (expects MONGO_URL and DB_NAME in .env)
mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ.get("DB_NAME", "cdr_trajectory_db")]

# FastAPI App
# Allow large file uploads up to 2 GB
app = FastAPI()
app.state.max_upload_size = 2 * 1024 * 1024 * 1024  # 2 GB
api_router = APIRouter(prefix="/api")

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# --------------------
# MODELS
# --------------------
class CDRRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    upload_id: str
    date: Optional[str] = None
    time: Optional[str] = None
    duration: Optional[str] = None
    a_number: Optional[str] = None
    a_imei: Optional[str] = None
    a_imei_type: Optional[str] = None
    a_imsi: Optional[str] = None
    a_lac_cid: Optional[str] = None
    a_sitename: Optional[str] = None
    b_number: Optional[str] = None
    b_imei: Optional[str] = None
    b_imei_type: Optional[str] = None
    b_imsi: Optional[str] = None
    b_lac_cid: Optional[str] = None
    b_sitename: Optional[str] = None
    calltype: Optional[str] = None
    direction: Optional[str] = None
    c_number: Optional[str] = None
    a_lat: Optional[float] = None
    a_long: Optional[float] = None
    b_lat: Optional[float] = None
    b_long: Optional[float] = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UploadMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")

    upload_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    filename: str
    total_records: int
    uploaded_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    user_id: Optional[str] = None


class TrajectoryAnalysis(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    upload_id: str
    analysis_type: str
    result: Dict[str, Any]
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AnalysisRequest(BaseModel):
    upload_id: str
    analysis_type: str = "comprehensive"


class ChatQuery(BaseModel):
    upload_id: str
    question: str

# --------------------
# Helper: header normalization & column mapping
# --------------------
COLUMN_MAPPING = {
    # Existing standard fields
    "date": "date",
    "time": "time",
    "duration": "duration",
    "a_number": "a_number",
    "a_imei": "a_imei",
    "a_imei_type": "a_imei_type",
    "a_imsi": "a_imsi",
    "a_lac_cid": "a_lac_cid",
    "a_sitename": "a_sitename",
    "b_number": "b_number",
    "b_imei": "b_imei",
    "b_imei_type": "b_imei_type",
    "b_imsi": "b_imsi",
    "b_lac_cid": "b_lac_cid",
    "b_sitename": "b_sitename",
    "calltype": "calltype",
    "direction": "direction",
    "c_number": "c_number",
    "a_lat": "a_lat",
    "a_long": "a_long",
    "b_lat": "b_lat",
    "b_long": "b_long",

    # Alternative flat CSV headers (e.g. maid, latitude, longitude, timestamp)
    "maid": "a_number",
    "latitude": "a_lat",
    "lat": "a_lat",
    "longitude": "a_long",
    "long": "a_long",
    "lon": "a_long",
    "timestamp": "time",       # Maps event timestamp to 'time'
    "event_timestamp": "time"
}
GPS_FIELDS = {"a_lat", "a_long", "b_lat", "b_long"}


def _normalize_header(h: Optional[str], idx: int) -> str:
    if h is None:
        return f"col_{idx}"
    raw = str(h).strip().lower()
    if raw == "":
        return f"col_{idx}"
    raw = raw.lstrip("%").strip()
    raw = raw.replace("%", "").replace(" ", "_").replace("/", "_").replace("-", "_")
    while "__" in raw:
        raw = raw.replace("__", "_")
    return COLUMN_MAPPING.get(raw, raw)


def _build_record_entry(key: str, value) -> tuple:
    """Return (key, processed_value) for a single CDR cell."""
    if value in (":", None, ""):
        return key, None
    if key in GPS_FIELDS:
        try:
            return key, float(value)
        except (TypeError, ValueError):
            return key, None
    return key, str(value).strip() if value is not None else None


# --------------------
# Helper: parse XLSX CDR
# --------------------
def parse_cdr_file(file_content: bytes, filename: str) -> List[Dict]:
    try:
        wb = openpyxl.load_workbook(io.BytesIO(file_content), data_only=True, read_only=True)
        ws = wb.active

        rows = list(ws.iter_rows(values_only=True))
        if len(rows) < 2:
            return []

        cleaned_headers = [_normalize_header(h, i) for i, h in enumerate(rows[0])]

        records = []
        for row in rows[1:]:
            if not row or all(v is None for v in row):
                continue
            entry = {}
            for i, value in enumerate(row):
                key = cleaned_headers[i]
                _, processed = _build_record_entry(key, value)
                entry[key] = processed
            records.append(entry)

        return records

    except Exception as e:
        logger.error(f"CDR XLSX parse error: {e}")
        raise HTTPException(status_code=400, detail=f"CDR parsing error: {e}")


# --------------------
# Helper: clean & validate a CSV DataFrame chunk
# --------------------
# Columns that should NEVER contain the header string as a value
_HEADER_SENTINEL_COLS = {"a_number", "b_number", "date", "time", "calltype", "direction", "a_lat", "a_long"}


def clean_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    Normalise a raw CSV DataFrame chunk before converting to records.
    - Strip & lowercase column names
    - Apply COLUMN_MAPPING to rename to backend field names
    - Drop rows where known CDR columns contain the literal column-header string
      (i.e. rows that are a repeated header line inside the CSV body)
    - Remove rows that are completely empty
    """
    # 1. Normalise column names
    df.columns = [_normalize_header(str(c), i) for i, c in enumerate(df.columns)]

    # 2. Drop rows that look like a repeated header (value == column name)
    #    Only check columns that exist in this df
    sentinel_cols = _HEADER_SENTINEL_COLS & set(df.columns)
    if sentinel_cols:
        mask = pd.Series([False] * len(df), index=df.index)
        for col in sentinel_cols:
            # If the cell value equals the column name it's a header repeat
            mask |= df[col].astype(str).str.strip().str.lower() == col
        df = df[~mask]

    # 3. Drop rows that are entirely NaN / empty
    df = df.dropna(how="all")

    return df.reset_index(drop=True)


# --------------------
# Helper: stream CSV CDR in chunks (for large 1-2 GB files)
# --------------------
def parse_cdr_csv_chunked(file_bytes: bytes, chunksize: int = 100000) -> Generator[List[Dict], None, None]:
    """
    Yields lists of CDR record dicts, reading the CSV chunksize rows at a time.
    Uses header=0 so pandas always treats row 0 as the header.
    Keeps memory usage bounded regardless of file size.
    """
    try:
        buf = io.BytesIO(file_bytes)

        # --- Sniff delimiter from first 4 KB ---
        sample = buf.read(4096).decode("utf-8", errors="replace")
        buf.seek(0)
        comma_count = sample.count(",")
        semi_count  = sample.count(";")
        tab_count   = sample.count("\t")
        if tab_count > comma_count and tab_count > semi_count:
            delimiter = "\t"
        elif semi_count > comma_count:
            delimiter = ";"
        else:
            delimiter = ","

        logger.info(f"CSV sniffed delimiter: {repr(delimiter)}")

        reader = pd.read_csv(
            buf,
            sep=delimiter,
            header=0,               # ← always treat first row as header
            dtype=str,              # keep everything as string; we cast later
            chunksize=chunksize,
            na_values=["", ":", "N/A", "null", "NULL", "None", "nan"],
            keep_default_na=True,
            encoding="utf-8",
            encoding_errors="replace",
            skipinitialspace=True,  # strip spaces after delimiter
            on_bad_lines="warn",    # skip malformed lines instead of crashing
        )

        chunk_num = 0
        total_rows = 0
        for raw_chunk in reader:
            chunk_num += 1

            # Clean: normalise headers + drop header-repeat rows
            chunk_df = clean_dataframe(raw_chunk)
            if chunk_df.empty:
                continue

            records = []
            for _, row in chunk_df.iterrows():
                entry: Dict[str, Any] = {}
                for key, value in row.items():
                    raw_val = None if (pd.isna(value) if not isinstance(value, str) else value.strip() == "") else value
                    _, processed = _build_record_entry(str(key), raw_val)
                    entry[str(key)] = processed
                records.append(entry)

            total_rows += len(records)
            logger.debug(f"CSV chunk {chunk_num}: {len(records)} rows (total so far: {total_rows})")
            yield records

        logger.info(f"CSV parse complete: {chunk_num} chunks, {total_rows} rows")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"CDR CSV parse error: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=f"CSV parsing error: {e}")




# --------------------
# GPS interpolation
# --------------------
async def interpolate_missing_gps(records: List[Dict]) -> List[Dict]:
    try:
        gps_valid = [r for r in records if r.get("a_lat") is not None and r.get("a_long") is not None]
        if len(gps_valid) < 2:
            return records

        for i, record in enumerate(records):
            record["_index"] = i

        known_idx = [r["_index"] for r in gps_valid]
        known_lat = [r["a_lat"] for r in gps_valid]
        known_long = [r["a_long"] for r in gps_valid]

        for i, r in enumerate(records):
            if r.get("a_lat") is not None and r.get("a_long") is not None:
                continue

            if i < known_idx[0]:
                r["a_lat"] = known_lat[0]
                r["a_long"] = known_long[0]
                r["interpolated"] = True

            elif i > known_idx[-1]:
                r["a_lat"] = known_lat[-1]
                r["a_long"] = known_long[-1]
                r["interpolated"] = True

            else:
                for j in range(len(known_idx) - 1):
                    if known_idx[j] < i < known_idx[j + 1]:
                        ratio = (i - known_idx[j]) / (known_idx[j + 1] - known_idx[j])
                        r["a_lat"] = known_lat[j] + ratio * (known_lat[j + 1] - known_lat[j])
                        r["a_long"] = known_long[j] + ratio * (known_long[j + 1] - known_long[j])
                        r["interpolated"] = True
                        break

        # remove helper index
        for r in records:
            if "_index" in r:
                del r["_index"]

        return records

    except Exception as e:
        logger.error(f"GPS interpolation error: {e}")
        return records

# --------------------
# Offline analysis helpers (all required by ask_chat)
# --------------------

def summarize_basic(records: List[Dict]) -> Dict[str, Any]:
    total = len(records)
    gps_count = sum(1 for r in records if r.get("a_lat") is not None and r.get("a_long") is not None)
    times = [r.get("time") for r in records if r.get("time")]
    try:
        time_range = f"{min(times)} → {max(times)}" if times else "Unknown"
    except Exception:
        time_range = "Unknown"

    return {
        "total_records": total,
        "records_with_gps": gps_count,
        "missing_gps": total - gps_count,
        "time_range": time_range,
    }


def top_contacts(records: List[Dict], topn: int = 10):
    counter = Counter()

    for r in records:
        user = r.get("b_number")  # nomor user
        c = r.get("c_number")     # kontak sebenarnyaa
        a = r.get("a_number")     # fallback jika C kosong

        if not user:
            continue

        # Kontak utama dari C-number
        if c and c not in [":", "", None]:
            counter[str(c).strip()] += 1
            continue

        # fallback ke A-number jika C-number kosong
        if a and a not in [":", "", None]:
            counter[str(a).strip()] += 1

    return counter.most_common(topn)






def graph_sna_stats(G: nx.Graph, topn: int = 10) -> Dict[str, Any]:
    if G.number_of_nodes() == 0:
        return {"top_degree": [], "top_betweenness": [], "nodes": 0, "edges": 0}
    deg = sorted(G.degree(weight="weight"), key=lambda x: x[1], reverse=True)
    try:
        eigen = nx.eigenvector_centrality_numpy(G) if G.number_of_nodes() > 1 else {n: 1 for n in G.nodes()}
    except Exception:
        eigen = {n: 1 for n in G.nodes()}
    betw = nx.betweenness_centrality(G, weight="weight")
    return {
        "top_degree": deg[:topn],
        "top_eigenvector": sorted(eigen.items(), key=lambda x: x[1], reverse=True)[:topn],
        "top_betweenness": sorted(betw.items(), key=lambda x: x[1], reverse=True)[:topn],
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
    }


def cluster_locations(records: List[Dict], eps_km: float = 0.2, min_samples: int = 3):
    pts = []
    idx_map = []
    for i, r in enumerate(records):
        lat = r.get("a_lat")
        lon = r.get("a_long")
        if lat is None or lon is None:
            continue
        pts.append([lat, lon])
        idx_map.append(i)

    if not pts:
        return {"clusters": {}, "labels": []}

    arr = np.array(pts)
    arr_rad = np.radians(arr)
    kms_per_radian = 6371.0088
    epsilon = eps_km / kms_per_radian
    db = DBSCAN(eps=epsilon, min_samples=min_samples, metric='haversine').fit(arr_rad)
    labels = db.labels_.tolist()

    clusters = defaultdict(list)
    for lab, idx in zip(labels, idx_map):
        clusters[int(lab)].append(records[idx])

    return {"clusters": {k: v for k, v in clusters.items()}, "labels": labels}


def timeseries_summary(records: List[Dict]):
    hours = defaultdict(int)
    for r in records:
        t = r.get("time")
        if not t:
            continue
        try:
            dt = dateparser.parse(t)
            hours[dt.hour] += 1
        except Exception:
            continue
    return {"by_hour": dict(sorted(hours.items()))}


def build_documents(records: List[Dict], max_docs: int = 2000):
    docs = []
    mapping = []
    for r in records[:max_docs]:
        parts = []
        if r.get("a_number"):
            parts.append(f"A:{r.get('a_number')}")
        if r.get("b_number"):
            parts.append(f"B:{r.get('b_number')}")
        if r.get("a_sitename"):
            parts.append(f"site:{r.get('a_sitename')}")
        if r.get("calltype"):
            parts.append(f"type:{r.get('calltype')}")
        if r.get("duration"):
            parts.append(f"dur:{r.get('duration')}")
        if r.get("a_lat") and r.get("a_long"):
            parts.append(f"loc:{round(r.get('a_lat'),5)},{round(r.get('a_long'),5)}")
        docs.append(" | ".join(parts))
        mapping.append(r)
    return docs, mapping


def answer_by_tfidf(question: str, docs: List[str], mapping: List[Dict], top_k: int = 3):
    if not docs:
        return None
    vect = TfidfVectorizer().fit_transform(docs + [question])
    sims = cosine_similarity(vect[-1], vect[:-1]).flatten()
    best_idx = sims.argsort()[::-1][:top_k]
    answers = []
    for idx in best_idx:
        answers.append({
            "score": float(sims[idx]),
            "record": mapping[idx]
        })
    return answers

# --------------------
# Local analysis function (used by analyze endpoint)
# --------------------
async def analyze_with_ai(records: List[Dict], analysis_type: str) -> Dict[str, Any]:
    try:
        total = len(records)
        gps_records = [r for r in records if r.get("a_lat") is not None and r.get("a_long") is not None]
        gps_count = len(gps_records)

        unique_locs = list({(round(r["a_lat"], 5), round(r["a_long"], 5)) for r in gps_records})

        activity_dist = {}
        for r in records:
            act = r.get("calltype") or "UNKNOWN"
            activity_dist[act] = activity_dist.get(act, 0) + 1

        times = [r.get("time") for r in records if r.get("time")]
        time_range = f"{min(times)} → {max(times)}" if times else "Unknown"

        return {
            "movement_patterns": "LLM disabled — simple movement frequency estimation only.",
            "key_locations": unique_locs[:10],
            "activity_analysis": activity_dist,
            "data_quality": {
                "total_records": total,
                "records_with_gps": gps_count,
                "missing_gps": total - gps_count,
                "missing_gps_percentage": round(((total - gps_count) / total) * 100, 2) if total else 0
            },
            "time_range": time_range,
        }

    except Exception as e:
        logger.error(f"AI analysis error: {e}")
        return {"error": str(e)}

# --------------------
# ROUTES
# --------------------
@api_router.get("/")
async def root():
    return {"message": "CDR Trajectory Analysis API (Local Mode)", "version": "1.0.0"}


# --------------------
# Batch insert helper
# --------------------
async def _insert_records_batch(records: List[Dict], upload_id: str) -> int:
    """
    Build MongoDB documents from CDR record dicts and bulk-insert them.
    We construct the doc manually so that:
    - The CDRRecord model's default-generated `id` and `timestamp` are always used
    - A 'timestamp' key coming from CSV data is never passed into the Pydantic model
      (CDR data doesn't have a 'timestamp' column in the standard schema; if it does
       exist in the CSV it just gets stored as-is in the extra fields, not as the
       Pydantic datetime field)
    Returns the number of documents actually inserted.
    """
    # Fields managed by CDRRecord itself — never take from source data
    _RESERVED = {"id", "upload_id", "timestamp"}

    docs = []
    skipped = 0
    for rec in records:
        try:
            # Strip reserved keys from raw CSV data to avoid Pydantic conflicts
            clean_rec = {k: v for k, v in rec.items() if k not in _RESERVED}
            record = CDRRecord(upload_id=upload_id, **clean_rec)
            rec_dict = record.model_dump()
            # Serialise the auto-generated datetime to ISO string for MongoDB
            rec_dict["timestamp"] = rec_dict["timestamp"].isoformat()
            docs.append(rec_dict)
        except Exception as e:
            skipped += 1
            logger.warning(f"Skipping invalid record (error: {e}) — data: {str(rec)[:120]}")

    if docs:
        try:
            await db.cdr_records.insert_many(docs, ordered=False)
        except Exception as e:
            logger.error(f"MongoDB insert_many error: {e}")
            raise

    if skipped:
        logger.info(f"Batch: inserted {len(docs)}, skipped {skipped} invalid records")

    return len(docs)


@api_router.post("/upload")
async def upload_cdr_file(file: UploadFile = File(...)):
    """
    Upload a CDR file (XLSX, XLS, atau CSV).
    - XLSX/XLS: loaded fully into memory (manageable for Excel files)
    - CSV: streamed in 5 000-row chunks → supports 1-2 GB files without OOM
    Response always includes 'success', 'upload_id', 'total_records', 'filename'.
    """
    try:
        fname = (file.filename or "").strip()
        ext = fname.lower().rsplit(".", 1)[-1] if "." in fname else ""

        if ext not in ("xlsx", "xls", "csv"):
            raise HTTPException(
                status_code=400,
                detail="Hanya file XLSX, XLS, atau CSV yang didukung"
            )

        logger.info(f"Upload dimulai: {fname} ({ext.upper()})")
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="File kosong")

        logger.info(f"File diterima: {fname}, ukuran {len(content) / (1024*1024):.1f} MB")

        upload_id = str(uuid.uuid4())
        total_inserted = 0

        if ext in ("xlsx", "xls"):
            # ── XLSX path ──────────────────────────────────────────────────────
            records = parse_cdr_file(content, fname)
            if not records:
                raise HTTPException(status_code=400, detail="File kosong atau format tidak valid")
            logger.info(f"XLSX parsed: {len(records)} rows")
            total_inserted = await _insert_records_batch(records, upload_id)

        else:
            # ── CSV path (chunked, memory-safe) ────────────────────────────────
            chunk_idx = 0
            for chunk_records in parse_cdr_csv_chunked(content):
                chunk_idx += 1
                if chunk_records:
                    n = await _insert_records_batch(chunk_records, upload_id)
                    total_inserted += n
                    logger.info(f"CSV chunk {chunk_idx}: inserted {n} rows (total: {total_inserted})")

            if total_inserted == 0:
                raise HTTPException(
                    status_code=400,
                    detail="File CSV kosong atau tidak ada data valid (cek format kolom)"
                )

        # ── Save metadata ──────────────────────────────────────────────────────
        metadata = UploadMetadata(
            upload_id=upload_id,
            filename=fname,
            total_records=total_inserted
        )
        meta = metadata.model_dump()
        meta["uploaded_at"] = meta["uploaded_at"].isoformat()
        await db.upload_metadata.insert_one(meta)

        logger.info(f"✅ Upload selesai: {fname} → {total_inserted} records (upload_id={upload_id})")

        return {
            "success": True,
            "status": "success",          # alias for compatibility
            "upload_id": upload_id,
            "total_records": total_inserted,
            "inserted_records": total_inserted,  # alias requested by user
            "filename": fname,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Upload error ({fname}): {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/uploads")
async def get_uploads():
    uploads = await db.upload_metadata.find({}, {"_id": 0}).to_list(1000)
    return {"uploads": uploads}


@api_router.get("/records/{upload_id}")
async def get_records(upload_id: str):
    # Fetch up to 5000 records that actually have GPS coordinates to prevent frontend lag
    # and ensure trajectory is visible.
    query = {
        "upload_id": upload_id,
        "a_lat": {"$ne": None},
        "a_long": {"$ne": None}
    }
    rows = await db.cdr_records.find(query, {"_id": 0}).sort("timestamp", 1).to_list(5000)
    
    tz_jkt = timezone(timedelta(hours=7))
    for row in rows:
        t_val = row.get("time")
        time_readable = None
        if t_val:
            try:
                dt = datetime.fromtimestamp(float(t_val), tz=tz_jkt)
                time_readable = dt.strftime('%Y-%m-%d %H:%M:%S')
            except (ValueError, TypeError):
                pass
        row["time_readable"] = time_readable

    return {"records": rows, "count": len(rows)}


@api_router.post("/analyze")
async def analyze_trajectory(request: AnalysisRequest):
    records = await db.cdr_records.find({"upload_id": request.upload_id}, {"_id": 0}).to_list(10000)
    if not records:
        raise HTTPException(status_code=404, detail="No records found")

    interpolated = await interpolate_missing_gps(records)
    analysis = await analyze_with_ai(interpolated, request.analysis_type)

    obj = TrajectoryAnalysis(
        upload_id=request.upload_id,
        analysis_type=request.analysis_type,
        result=analysis,
    )
    doc = obj.model_dump()
    doc["created_at"] = doc["created_at"].isoformat()
    await db.trajectory_analysis.insert_one(doc)

    return {
        "success": True,
        "analysis": analysis,
    }

@api_router.get("/sna/{upload_id}")
async def analyze_sna(upload_id: str):
    """
    Endpoint for Social Network Analysis (SNA)
    """
    records = await db.cdr_records.find({"upload_id": upload_id}, {"_id": 0}).to_list(50000)
    if not records:
        raise HTTPException(status_code=404, detail="No records found")

    def has_valid_dest(r):
        b = r.get("b_number")
        c = r.get("c_number")
        if b and b.replace("+", "").isdigit():
            return True
        if c and c.replace("+", "").isdigit():
            return True
        return False

    if not any(has_valid_dest(r) for r in records):
        return {
            "success": True,
            "sna_enabled": False,
            "message": "CDR tidak memiliki B-number/C-number sehingga tidak dapat dibuat SNA"
        }

    G = build_contact_graph(records)
    sna_stats = graph_sna_stats(G, topn=20)

    nodes = [{"id": n, "degree": G.degree(n)} for n in G.nodes()]
    edges = [
        {"source": u, "target": v, "weight": d.get("weight", 1)}
        for u, v, d in G.edges(data=True)
    ]

    return {
        "success": True,
        "sna_enabled": True,
        "nodes": nodes,
        "edges": edges,
        "stats": sna_stats
    }


@api_router.get("/statistics/{upload_id}")
async def get_statistics(upload_id: str):
    # MongoDB aggregations to avoid loading millions of records into memory for large files
    total_records = await db.cdr_records.count_documents({"upload_id": upload_id})
    
    # 1. GPS Bounds and counts
    gps_pipeline = [
        {"$match": {"upload_id": upload_id, "a_lat": {"$ne": None}, "a_long": {"$ne": None}}},
        {"$group": {
            "_id": None,
            "min_lat": {"$min": "$a_lat"},
            "max_lat": {"$max": "$a_lat"},
            "min_long": {"$min": "$a_long"},
            "max_long": {"$max": "$a_long"},
            "avg_lat": {"$avg": "$a_lat"},
            "avg_long": {"$avg": "$a_long"},
            "gps_count": {"$sum": 1}
        }}
    ]
    gps_stats = await db.cdr_records.aggregate(gps_pipeline).to_list(1)
    
    bounds = None
    records_with_gps = 0
    if gps_stats:
        res = gps_stats[0]
        records_with_gps = res.get("gps_count", 0)
        bounds = {
            "min_lat": res.get("min_lat"),
            "max_lat": res.get("max_lat"),
            "min_long": res.get("min_long"),
            "max_long": res.get("max_long"),
            "center_lat": res.get("avg_lat"),
            "center_long": res.get("avg_long"),
        }
        
    missing_gps = total_records - records_with_gps
    perc = round((missing_gps / total_records) * 100, 2) if total_records > 0 else 0

    # 2. Activity Distribution (Calltype)
    act_pipeline = [
        {"$match": {"upload_id": upload_id}},
        {"$group": {"_id": "$calltype", "count": {"$sum": 1}}}
    ]
    act_list = await db.cdr_records.aggregate(act_pipeline).to_list(None)
    activity_dist = {}
    for a in act_list:
        k = str(a["_id"]) if a["_id"] is not None else "UNKNOWN"
        activity_dist[k] = activity_dist.get(k, 0) + a["count"]
        
    # 3. Direction Distribution
    dir_pipeline = [
        {"$match": {"upload_id": upload_id}},
        {"$group": {"_id": "$direction", "count": {"$sum": 1}}}
    ]
    dir_list = await db.cdr_records.aggregate(dir_pipeline).to_list(None)
    direction_dist = {}
    for d in dir_list:
        k = str(d["_id"]) if d["_id"] is not None else "UNKNOWN"
        direction_dist[k] = direction_dist.get(k, 0) + d["count"]

    return {
        "total_records": total_records,
        "records_with_gps": records_with_gps,
        "missing_gps": missing_gps,
        "missing_gps_percentage": perc,
        "gps_bounds": bounds,
        "activity_distribution": activity_dist,
        "direction_distribution": direction_dist
    }

def build_contact_graph(records):
    """
    Graph SNA paling akurat — otomatis mendeteksi hubungan A <-> B
    dan menggunakan C-number jika tersedia.
    """

    G = nx.Graph()

    for r in records:

        # Ambil nomor A dan B dasar
        a = r.get("a_number")
        b = r.get("b_number")
        c = r.get("c_number")

        # Jika ada C-number, itu yang paling akurat
        if c not in [None, "", ":"]:
            # outbound: A -> C
            if r.get("direction") in ["MO", "Outgoing", "Keluar"]:
                src = a
                dst = c
            # inbound: B -> C
            else:
                src = b
                dst = c

        # Jika tidak ada C-number → fallback A <-> B
        else:
            src = a
            dst = b

        if not src or not dst:
            continue

        src = str(src).strip()
        dst = str(dst).strip()

        # Weight berdasarkan durasi
        dur = r.get("duration")
        try:
            dur = int(dur)
        except:
            dur = 1

        if G.has_edge(src, dst):
            G[src][dst]["weight"] += dur
            G[src][dst]["count"] += 1
        else:
            G.add_edge(src, dst, weight=dur, count=1)

    return G

@api_router.get("/graph/{upload_id}")
async def get_sna_graph(upload_id: str):
    """
    Endpoint khusus untuk Cytoscape graph di frontend
    """
    records = await db.cdr_records.find(
        {"upload_id": upload_id}, {"_id": 0}
    ).to_list(50000)

    if not records:
        raise HTTPException(status_code=404, detail="No records found for this upload_id")

    # Build graph
    G = build_contact_graph(records)

    # Convert KE FORMAT CYTOSCAPE (WAJIB!)
    nodes = [{"data": {"id": n}} for n in G.nodes()]

    edges = [
        {
            "data": {
                "source": u,
                "target": v,
                "weight": d.get("weight", 1)
            }
        }
        for u, v, d in G.edges(data=True)
    ]

    return {"nodes": nodes, "edges": edges}




# --------------------
# Advanced Analysis Helpers
# --------------------
def analyze_mobility(records: List[Dict]) -> Dict[str, Any]:
    gps_records = [r for r in records if r.get("a_lat") is not None and r.get("a_long") is not None]
    if not gps_records:
        return {"error": "No GPS data available"}

    # Top Cell Towers / Sites
    sites = [r.get("a_sitename") for r in records if r.get("a_sitename")]
    top_sites = Counter(sites).most_common(5)

    # Hotspots (simple clustering by rounding lat/long)
    locs = [f"{round(r['a_lat'], 4)},{round(r['a_long'], 4)}" for r in gps_records]
    top_locs = Counter(locs).most_common(5)
    
    hotspots = []
    for loc_str, count in top_locs:
        lat, lon = map(float, loc_str.split(","))
        hotspots.append({"lat": lat, "long": lon, "count": count})

    return {
        "top_sites": top_sites,
        "hotspots": hotspots,
        "total_movements": len(gps_records)
    }

def analyze_activity_detailed(records: List[Dict]) -> Dict[str, Any]:
    total = len(records)
    if total == 0:
        return {}
        
    # By Type
    types = Counter(r.get("calltype") for r in records)
    
    # By Direction
    directions = Counter(r.get("direction") for r in records)
    
    # By Hour
    hours = defaultdict(int)
    # By Day
    days = defaultdict(int)
    
    for r in records:
        if r.get("time"):
            try:
                dt = dateparser.parse(r["time"])
                hours[dt.hour] += 1
            except: pass
        if r.get("date"):
            try:
                d = dateparser.parse(r["date"]).strftime("%A")
                days[d] += 1
            except: pass
            
    return {
        "total": total,
        "by_type": dict(types),
        "by_direction": dict(directions),
        "peak_hour": max(hours, key=hours.get) if hours else None,
        "peak_day": max(days, key=days.get) if days else None,
        "hours_dist": dict(sorted(hours.items()))
    }

def analyze_forensic(records: List[Dict]) -> Dict[str, Any]:
    # Suspicious: High frequency SMS (spam?)
    sms_out = [r for r in records if r.get("calltype") == "SMS" and r.get("direction") in ["Outgoing", "MO"]]
    
    # Check for burst (many SMS in short time) - simplified
    suspicious_numbers = []
    if sms_out:
        dest_counts = Counter(r.get("b_number") for r in sms_out)
        # If sent > 10 SMS to same number
        for num, count in dest_counts.items():
            if count > 10:
                suspicious_numbers.append({"number": num, "reason": "High frequency outgoing SMS", "count": count})
                
    # Short duration calls (spam calls?)
    short_calls = [r for r in records if r.get("calltype") == "Voice" and r.get("duration") and int(r.get("duration")) < 5]
    if short_calls:
         dest_counts = Counter(r.get("b_number") for r in short_calls)
         for num, count in dest_counts.items():
             if count > 5:
                 suspicious_numbers.append({"number": num, "reason": "Multiple short duration calls (<5s)", "count": count})

    return {
        "suspicious_numbers": suspicious_numbers,
        "flagged_count": len(suspicious_numbers)
    }

@api_router.post("/ask_chat")
async def ask_chat(req: ChatQuery):
    try:
        # --- Load data ---
        records = await db.cdr_records.find({"upload_id": req.upload_id}, {"_id": 0}).to_list(50000)
        if not records:
            raise HTTPException(status_code=404, detail="Data CDR tidak ditemukan")

        sample = records # Use full records for better accuracy if possible, or cap if too slow
        if len(sample) > 10000:
            sample = sample[:10000]

        q_lower = (req.question or "").lower()
        
        # =========================================================
        #  ROUTER: Rule-based intent matching
        # =========================================================
        
        # 1. SNA / CONTACTS
        if any(x in q_lower for x in ["siapa", "kontak", "hubung", "interaksi", "b number", "jaringan", "cluster"]):
            topc = top_contacts(sample, topn=10)
            G = build_contact_graph(sample)
            sna = graph_sna_stats(G)
            
            # Specific: "Interaksi dua arah"
            if "dua arah" in q_lower:
                # Filter edges where count > 1 (simplification, ideally check directionality)
                two_way = []
                for u, v, d in G.edges(data=True):
                    if d.get("count", 0) >= 2: # Assumption: count >= 2 implies potential 2-way or frequent 1-way
                         two_way.append({"contact": v if u == sample[0].get("a_number") else u, "weight": d.get("weight")})
                return {"answer": {"type": "sna_interaction", "data": two_way[:10]}}

            return {
                "answer": {
                    "type": "sna",
                    "top_contacts": topc,
                    "sna_stats": sna,
                    "summary": f"Ditemukan {len(topc)} kontak aktif."
                }
            }

        # 2. MOBILITY / LOCATION / MAP
        if any(x in q_lower for x in ["lokasi", "peta", "gerak", "pindah", "tower", "koordinat", "mana"]):
            mob = analyze_mobility(sample)
            
            # If map requested or implied
            return {
                "answer": {
                    "type": "map_response",
                    "mobility": mob,
                    "locations": mob.get("hotspots", []),
                    "summary": f"User terdeteksi di {len(mob.get('hotspots', []))} lokasi utama."
                }
            }

        # 3. ACTIVITY / TIME
        if any(x in q_lower for x in ["aktivitas", "sms", "call", "telepon", "jam", "hari", "kapan", "berapa"]):
            act = analyze_activity_detailed(sample)
            
            # Specific: Date query
            import re
            date_pattern = r"(\d{1,2}[-/ ]\d{1,2}[-/ ]20\d{2})"
            date_match = re.search(date_pattern, q_lower)
            if date_match:
                try:
                    target_date = dateparser.parse(date_match.group(1)).date()
                    count = sum(1 for r in sample if r.get("date") and dateparser.parse(r["date"]).date() == target_date)
                    return {"answer": {"type": "text", "text": f"Pada tanggal {target_date}, terdapat {count} aktivitas."}}
                except: pass

            return {
                "answer": {
                    "type": "activity",
                    "stats": act,
                    "summary": f"Total aktivitas: {act['total']}. Peak hour: {act['peak_hour']}:00."
                }
            }

        # 4. FORENSIC / SUSPICIOUS
        if any(x in q_lower for x in ["curiga", "aneh", "spam", "bot", "forensik", "transaksi"]):
            forensic = analyze_forensic(sample)
            return {
                "answer": {
                    "type": "forensic",
                    "data": forensic,
                    "summary": f"Ditemukan {forensic['flagged_count']} indikator mencurigakan."
                }
            }

        # 5. FALLBACK: TF-IDF
        docs, mapping = build_documents(sample)
        if docs:
            ans = answer_by_tfidf(req.question, docs, mapping, top_k=5)
            if ans:
                return {"answer": {"type": "tfidf", "matches": ans}}

        return {"answer": {"type": "text", "text": "Maaf, saya tidak mengerti pertanyaan Anda. Coba tanyakan tentang 'lokasi', 'kontak', atau 'aktivitas'."}}

    except Exception as e:
        logger.exception("ask_chat_error")
        raise HTTPException(status_code=500, detail=str(e))




# include router and cors
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_db_client():
    try:
        await db.cdr_records.create_index("upload_id", background=True)
        logger.info("Ensured upload_id index exists.")
    except Exception as e:
        logger.warning(f"Failed to create index: {e}")

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()