import os
import json
import datetime

DB_FILE = "local_db.json"

def load_data():
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"users": {}, "config": {}, "outreach": [], "upgrade_requests": []}

def save_data(data):
    try:
        with open(DB_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

def plan_daily_limit(plan):
    return 999999  # Bypassed daily limits as per user request

class Database:
    @staticmethod
    def get_user(email):
        if not email:
            return None
        email_key = email.lower()
        data = load_data()
        user = data["users"].get(email_key)
        if not user:
            # Return default template for admin/guest
            user = {
                "email": email_key,
                "name": "User",
                "picture": "",
                "googleId": "user-id",
                "plan": "premium",
                "cvText": "",
                "cvPath": "",
                "promptTemplate": ""
            }
        
        user["emailsSent"] = 0
        user["emailsLimit"] = 999999
        return user

    @staticmethod
    def get_users():
        data = load_data()
        return list(data["users"].values())

    @staticmethod
    def save_user(email, user_details):
        if not email:
            return None
        email_key = email.lower()
        data = load_data()
        existing = data["users"].get(email_key) or {}
        
        for key, val in user_details.items():
            existing[key] = val
        existing["email"] = email_key
        existing["updatedAt"] = datetime.datetime.utcnow().isoformat()
        
        data["users"][email_key] = existing
        save_data(data)
        return existing

    @staticmethod
    def get_config():
        # Read directly from .env variables as per user request
        return {
            "LINKEDIN_EMAIL": os.environ.get("LINKEDIN_EMAIL", ""),
            "LINKEDIN_PASSWORD": os.environ.get("LINKEDIN_PASSWORD", ""),
            "GROQ_API_KEY": os.environ.get("GROQ_API_KEY", ""),
            "SMTP_HOST": os.environ.get("SMTP_HOST", ""),
            "SMTP_PORT": os.environ.get("SMTP_PORT", "465"),
            "SMTP_USER": os.environ.get("SMTP_USER", ""),
            "SMTP_PASS": os.environ.get("SMTP_PASS", ""),
            "HEADLESS": os.environ.get("HEADLESS", "true"),
            "TEST_MODE": os.environ.get("TEST_MODE", "true"),
            "MAX_PAGES": os.environ.get("MAX_PAGES", "5"),
            "CV_PATH": os.environ.get("CV_PATH", "./my_cv.pdf"),
            "urls": os.environ.get("URLS", "")
        }

    @staticmethod
    def save_config(config_data):
        # Configuration is loaded from .env, write to local db file as backup
        data = load_data()
        for key, val in config_data.items():
            data["config"][key] = val
        save_data(data)
        return data["config"]

    @staticmethod
    def record_outreach(user_email, outreach_data):
        data = load_data()
        user_key = (user_email or "guest@reachoutai.local").lower()
        recip_key = (outreach_data.get("recipientEmail") or "").lower()
        record = {
            "userEmail": user_key,
            "recipientEmail": recip_key,
            "recruiterName": outreach_data.get("recruiterName"),
            "subject": outreach_data.get("subject"),
            "testMode": outreach_data.get("testMode", False),
            "urn": outreach_data.get("urn") or outreach_data.get("postUrn") or "",
            "sentAt": datetime.datetime.utcnow().isoformat()
        }
        data["outreach"].append(record)
        save_data(data)
        return record

    @staticmethod
    def is_email_sent_before(user_email, recipient_email, urn=None):
        data = load_data()
        recip_key = (recipient_email or "").lower()
        if not recip_key:
            return False
        for record in data.get("outreach", []):
            if (record.get("recipientEmail") or "").lower() == recip_key:
                record_urn = record.get("urn") or record.get("postUrn") or ""
                if urn and record_urn:
                    if record_urn == urn:
                        return True
                else:
                    return True
        return False

    @staticmethod
    def get_outreach_history(user_email):
        data = load_data()
        email_key = user_email.lower()
        return [o for o in data["outreach"] if o.get("userEmail") == email_key]

    @staticmethod
    def clear_outreach_history(user_email):
        data = load_data()
        email_key = user_email.lower()
        data["outreach"] = [o for o in data["outreach"] if o.get("userEmail") != email_key]
        save_data(data)
        return True

    @staticmethod
    def get_global_outreach(limit=100):
        data = load_data()
        return data["outreach"][-limit:]

    @staticmethod
    def get_upgrade_requests():
        data = load_data()
        return data["upgrade_requests"]

    @staticmethod
    def create_upgrade_request(email, requested_plan):
        data = load_data()
        request = {
            "email": email.lower(),
            "plan": requested_plan,
            "createdAt": datetime.datetime.utcnow().isoformat()
        }
        data["upgrade_requests"].append(request)
        save_data(data)
        return request

    @staticmethod
    def reset_usage(email):
        return True
