import json
import logging

from flask import Blueprint, request, abort
from linebot.v3 import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.webhooks import MessageEvent, TextMessageContent
from config import Config
from services.line_service import send_when2meet_flex

webhook_bp = Blueprint("webhook", __name__)
handler = WebhookHandler(Config.LINE_CHANNEL_SECRET)
logger = logging.getLogger(__name__)

TRIGGER_KEYWORDS = ["查空閒", "空閒", "when2meet", "排程", "填空閒"]
LIFECYCLE_EVENTS = {"join", "leave", "memberJoined", "memberLeft", "follow", "unfollow"}


@webhook_bp.route("/webhook", methods=["POST"])
def webhook():
    req_id = request.headers.get("X-Line-Request-Id", "-")
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    log_webhook_events(body, req_id)

    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        logger.warning("LINE webhook invalid signature request_id=%s", req_id)
        abort(400)
    except Exception:
        logger.exception("LINE webhook unexpected error request_id=%s", req_id)
        abort(500)
    return "OK", 200


@handler.add(MessageEvent, message=TextMessageContent)
def handle_message(event):
    # 只處理群組訊息
    if event.source.type != "group":
        return

    text = event.message.text.strip()
    if not any(kw in text for kw in TRIGGER_KEYWORDS):
        return

    line_group_id = event.source.group_id
    send_when2meet_flex(event.reply_token, line_group_id)


def log_webhook_events(raw_body, req_id):
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        logger.warning("LINE webhook invalid JSON request_id=%s", req_id)
        return

    events = payload.get("events") or []
    if not events:
        logger.warning(
            "LINE webhook no events request_id=%s destination=%s",
            req_id,
            payload.get("destination", "-"),
        )
        return

    for event in events:
        event_type = event.get("type", "-")
        source = event.get("source") or {}
        joined_ids = extract_member_ids((event.get("joined") or {}).get("members"))
        left_ids = extract_member_ids((event.get("left") or {}).get("members"))

        if event_type in LIFECYCLE_EVENTS:
            logger.warning(
                (
                    "LINE lifecycle event=%s source_type=%s group_id=%s room_id=%s "
                    "user_id=%s joined_ids=%s left_ids=%s mode=%s request_id=%s"
                ),
                event_type,
                source.get("type", "-"),
                source.get("groupId", "-"),
                source.get("roomId", "-"),
                source.get("userId", "-"),
                joined_ids,
                left_ids,
                event.get("mode", "-"),
                req_id,
            )


def extract_member_ids(members):
    if not members:
        return "-"
    ids = []
    for member in members:
        if member.get("type") == "user":
            ids.append(member.get("userId", "-"))
    return ",".join(ids) if ids else "-"
