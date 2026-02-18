from config import Config
from linebot.v3.messaging import (
    ApiClient,
    Configuration,
    MessagingApi,
    ReplyMessageRequest,
    FlexMessage,
    FlexContainer,
)
import json

line_configuration = Configuration(access_token=Config.LINE_CHANNEL_ACCESS_TOKEN)


def send_when2meet_flex(reply_token, group_db_id):
    """回傳含填寫/統計按鈕的 Flex Message。"""
    schedule_url = f"https://liff.line.me/{Config.LIFF_ID_SCHEDULE}?group={group_db_id}"
    stats_url = f"{Config.BASE_URL}/stats?group={group_db_id}"

    flex_content = {
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "spacing": "sm",
            "contents": [
                {
                    "type": "text",
                    "text": "空閒時間排程",
                    "weight": "bold",
                    "size": "xl",
                    "color": "#333333",
                },
                {
                    "type": "text",
                    "text": "填寫你每週可用的時段，幫助大家找到共同空閒時間",
                    "size": "sm",
                    "color": "#888888",
                    "wrap": True,
                },
            ],
        },
        "footer": {
            "type": "box",
            "layout": "vertical",
            "spacing": "sm",
            "contents": [
                {
                    "type": "button",
                    "action": {
                        "type": "uri",
                        "label": "填寫空閒時間",
                        "uri": schedule_url,
                    },
                    "style": "primary",
                    "color": "#4CAF50",
                },
                {
                    "type": "button",
                    "action": {
                        "type": "uri",
                        "label": "查看統計",
                        "uri": stats_url,
                    },
                    "style": "secondary",
                },
            ],
        },
    }

    with ApiClient(line_configuration) as api_client:
        messaging_api = MessagingApi(api_client)
        messaging_api.reply_message_with_http_info(
            ReplyMessageRequest(
                reply_token=reply_token,
                messages=[
                    FlexMessage(
                        alt_text="點此填寫或查看空閒時間排程",
                        contents=FlexContainer.from_dict(flex_content),
                    )
                ],
            )
        )
