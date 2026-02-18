from flask import Blueprint, render_template, request
from config import Config
from models.database import DAY_CODES, DAY_NAMES, SLOT_CODES, SLOT_TIMES

pages_bp = Blueprint("pages", __name__)


@pages_bp.route("/health")
def health():
    return "OK", 200


@pages_bp.route("/schedule")
def schedule_editor():
    group_id = request.args.get("group", "")
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
    group_id = request.args.get("group", "")
    return render_template(
        "stats_viewer.html",
        group_id=group_id,
        day_codes=DAY_CODES,
        day_names=DAY_NAMES,
        slot_codes=SLOT_CODES,
        slot_times=SLOT_TIMES,
    )
