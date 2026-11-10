import httpx
import logging
import os

async def send_telegram_alert(device_code: str, metric_name: str, current_value: float, threshold_value: float, unit: str):
    """Gửi thông báo khi một chỉ số vượt ngưỡng."""
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not bot_token or not chat_id:
        logging.error("[TELEGRAM] Chua cau hinh TELEGRAM_BOT_TOKEN hoac TELEGRAM_CHAT_ID")
        return

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"

    message = (
        f"🚨 *CẢNH BÁO CHẤT LƯỢNG KHÔNG KHÍ*\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"📍 *Thiết bị:* `{device_code}`\n"
        f"⚠️ *Chỉ số vượt ngưỡng:* *{metric_name}*\n"
        f"📊 *Giá trị hiện tại:* `{current_value} {unit}`\n"
        f"🎯 *Ngưỡng cài đặt:* `{threshold_value} {unit}`\n"
        f"🔔 *Hành động:* Hệ thống đã ghi nhận cảnh báo vượt ngưỡng.\n"
        f"━━━━━━━━━━━━━━━━━━━"
    )

    payload = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "Markdown"
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            result = response.json()
            if result.get("ok"):
                logging.info(f"[TELEGRAM] Da gui canh bao thanh cong cho {metric_name}")
            else:
                logging.error("[TELEGRAM] Telegram API tu choi tin nhan: %s", result.get("description"))
    except (httpx.HTTPError, ValueError) as error:
        logging.error("[TELEGRAM] Loi gui tin nhan: %s", error)