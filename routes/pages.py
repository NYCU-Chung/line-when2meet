from flask import Blueprint, render_template, request
from urllib.parse import parse_qs, unquote, urlparse
from config import Config
from models.database import DAY_CODES, DAY_NAMES, SLOT_CODES, SLOT_TIMES

pages_bp = Blueprint("pages", __name__)


@pages_bp.route("/health")
def health():
    return "OK", 200


def _parse_group_from_query_blob(blob):
    if not blob:
        return ""

    candidates = [str(blob)]
    for _ in range(2):
        decoded = unquote(candidates[-1])
        if decoded == candidates[-1]:
            break
        candidates.append(decoded)

    for text in candidates:
        raw = text.strip()
        if not raw:
            continue

        query = ""
        if raw.startswith("http://") or raw.startswith("https://"):
            query = urlparse(raw).query
        elif "?" in raw:
            query = raw.split("?", 1)[1]
        else:
            query = raw.lstrip("#?")

        if not query:
            continue

        parsed = parse_qs(query)
        for key in ("group", "group_id"):
            values = parsed.get(key) or []
            if values and str(values[0]).strip():
                return str(values[0]).strip()
    return ""


def resolve_group_id_from_request():
    for key in ("group", "group_id"):
        value = (request.args.get(key) or "").strip()
        if value:
            return value

    # LIFF may wrap original URL query in liff.state, sometimes double-encoded.
    for state_key in ("liff.state", "liff_state"):
        parsed = _parse_group_from_query_blob(request.args.get(state_key, ""))
        if parsed:
            return parsed
    return ""


@pages_bp.route("/schedule")
def schedule_editor():
    group_id = resolve_group_id_from_request()
    return render_template(
        "schedule_editor.html",
        liff_id=Config.LIFF_ID_SCHEDULE,
        group_id=group_id,
        day_codes=DAY_CODES,
        day_names=DAY_NAMES,
        slot_codes=SLOT_CODES,
        slot_times=SLOT_TIMES,
    )


@pages_bp.route("/stats")
def stats_viewer():
    group_id = resolve_group_id_from_request()
    return render_template(
        "stats_viewer.html",
        group_id=group_id,
        day_codes=DAY_CODES,
        day_names=DAY_NAMES,
        slot_codes=SLOT_CODES,
        slot_times=SLOT_TIMES,
    )
