from flask import Blueprint, request, abort
from linebot.v3 import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.webhooks import MessageEvent, TextMessageContent
from config import Config
from models.database import get_db, get_or_create_group
from services.line_service import send_when2meet_flex

webhook_bp = Blueprint("webhook", __name__)
handler = WebhookHandler(Config.LINE_CHANNEL_SECRET)

TRIGGER_KEYWORDS = ["查空閒", "空閒", "when2meet", "排程", "填空閒"]


@webhook_bp.route("/webhook", methods=["POST"])
def webhook():
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)
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
    conn = get_db()
    try:
        group_db_id = get_or_create_group(conn, line_group_id)
    finally:
        conn.close()

    send_when2meet_flex(event.reply_token, group_db_id)
