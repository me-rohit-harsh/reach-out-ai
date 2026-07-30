import os
import json
import base64
import urllib.parse
import asyncio
import datetime
from fastapi import FastAPI, Request, Response, Depends, HTTPException, status
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from jose import jwt, JWTError
import requests
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

from db import Database
from ai import AIGenerator
from mailer import Mailer
from scraper import LinkedInScraper

app = FastAPI()

PORT = int(os.environ.get("PORT", 3000))
JWT_SECRET = os.environ.get("JWT_SECRET", "fallback-jwt-secret-key-123")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "rahulkumar828515@gmail.com")
running_tasks = set()

# Helper to check if email is admin
def is_admin(email: str) -> bool:
    if not email:
        return False
    email_lower = email.lower()
    if email_lower == 'guest@reachoutai.local':
        return True
    return email_lower == ADMIN_EMAIL.lower()

# Get authenticated user from cookie
async def get_current_user(request: Request):
    token = request.cookies.get("auth_token")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated"
        )
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        email = payload.get("email")
        name = payload.get("name")
        is_guest = payload.get("isGuest", False)
        if email is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token payload"
            )
        return {"email": email, "name": name, "isGuest": is_guest}
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token decode failed"
        )

# Get current admin user
async def get_current_admin(current_user=Depends(get_current_user)):
    if not is_admin(current_user["email"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Admin access only"
        )
    return current_user

# Setup Static files directories
os.makedirs("uploads/imports", exist_ok=True)
os.makedirs("templates", exist_ok=True)
os.makedirs("public", exist_ok=True)

# Mount static uploads
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")
app.mount("/public", StaticFiles(directory="public"), name="public")

# ── ROUTE PAGES (Serve templates directly) ──

@app.get("/")
def read_index():
    return FileResponse("templates/app.html")

@app.get("/app")
def read_app():
    return RedirectResponse(url="/")

@app.get("/admin")
def read_admin(request: Request):
    token = request.cookies.get("auth_token")
    if not token:
        return RedirectResponse(url="/app?redirect=admin")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        email = payload.get("email")
        if not email or not is_admin(email):
            return RedirectResponse(url="/app?redirect=admin")
    except JWTError:
        return RedirectResponse(url="/app?redirect=admin")
    return FileResponse("templates/admin.html")

# ── AUTHENTICATION ENDPOINTS ──

@app.get("/auth/google")
def auth_google():
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    if not client_id:
        raise HTTPException(status_code=500, detail="GOOGLE_CLIENT_ID not configured")
    
    redirect_uri = os.environ.get("GOOGLE_REDIRECT_URI", f"http://localhost:{PORT}/auth/google/callback")
    scope = "openid email profile https://www.googleapis.com/auth/gmail.send"
    
    auth_url = (
        "https://accounts.google.com/o/oauth2/v2/auth"
        f"?client_id={client_id}"
        f"&redirect_uri={urllib.parse.quote(redirect_uri)}"
        "&response_type=code"
        f"&scope={urllib.parse.quote(scope)}"
        "&access_type=offline"
        "&prompt=consent"
    )
    return RedirectResponse(url=auth_url)

@app.get("/auth/google/callback")
def auth_google_callback(code: str = None, error: str = None):
    if error:
        return RedirectResponse(url=f"/app?error={urllib.parse.quote(error)}")
    if not code:
        return RedirectResponse(url="/app?error=no_code")
        
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.environ.get("GOOGLE_REDIRECT_URI", f"http://localhost:{PORT}/auth/google/callback")
    
    try:
        # Exchange code for tokens
        token_res = requests.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code"
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        tokens = token_res.json()
        if "error" in tokens:
            raise Exception(tokens.get("error_description", tokens.get("error")))
            
        # Fetch user info
        user_info_res = requests.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )
        user_info = user_info_res.json()
        email = user_info.get("email")
        if not email:
            raise Exception("Email not returned by Google")
            
        updates = {
            "googleId": user_info.get("sub"),
            "name": user_info.get("name", "Google User"),
            "picture": user_info.get("picture", ""),
            "accessToken": tokens.get("access_token"),
            "tokenExpiry": int(datetime.datetime.utcnow().timestamp() * 1000) + (tokens.get("expires_in", 3600) * 1000)
        }
        if tokens.get("refresh_token"):
            updates["refreshToken"] = tokens.get("refresh_token")
            
        saved_user = Database.save_user(email, updates)
        
        # Sign JWT token
        jwt_payload = {
            "email": saved_user["email"],
            "name": saved_user.get("name", ""),
            "exp": datetime.datetime.utcnow() + datetime.timedelta(days=7)
        }
        jwt_token = jwt.encode(jwt_payload, JWT_SECRET, algorithm="HS256")
        
        response = RedirectResponse(url="/app")
        response.set_cookie(
            key="auth_token",
            value=jwt_token,
            httponly=True,
            max_age=7 * 24 * 60 * 60,
            path="/"
        )
        return response
    except Exception as e:
        print("Google OAuth error:", str(e))
        return RedirectResponse(url=f"/app?error={urllib.parse.quote(str(e))}")

@app.post("/api/guest-login")
def guest_login():
    try:
        guest_email = 'guest@reachoutai.local'
        guest_user = Database.get_user(guest_email)
        if not guest_user:
            guest_user = Database.save_user(guest_email, {
                "name": "Guest User",
                "picture": "",
                "googleId": "guest-id",
                "plan": "free",
                "cvText": "",
                "cvPath": "",
                "promptTemplate": ""
            })
            
        jwt_payload = {
            "email": guest_user["email"],
            "name": guest_user["name"],
            "isGuest": True,
            "exp": datetime.datetime.utcnow() + datetime.timedelta(days=1)
        }
        jwt_token = jwt.encode(jwt_payload, JWT_SECRET, algorithm="HS256")
        
        response = Response(status_code=200)
        response.set_cookie(
            key="auth_token",
            value=jwt_token,
            httponly=True,
            max_age=24 * 60 * 60,
            path="/"
        )
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(key="auth_token", path="/")
    return {"success": True}

# ── PROTECTED ENDPOINTS ──

@app.get("/api/user-profile")
async def user_profile(current_user=Depends(get_current_user)):
    try:
        user = Database.get_user(current_user["email"])
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
            
        config = Database.get_config()
        test_mode = config.get("TEST_MODE") == "true"
        
        return {
            "email": user["email"],
            "name": user.get("name", ""),
            "picture": user.get("picture", ""),
            "plan": user.get("plan", "free"),
            "emailsSent": user.get("emailsSent", 0),
            "emailsLimit": user.get("emailsLimit", 20),
            "isAdmin": is_admin(user["email"]),
            "systemTestMode": test_mode,
            "cvPath": user.get("cvPath", "")
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/config")
async def get_config(current_user=Depends(get_current_admin)):
    try:
        config = Database.get_config()
        return config
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/config")
async def save_config(request: Request, current_user=Depends(get_current_admin)):
    try:
        data = await request.json()
        Database.save_config(data)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/upload-cv")
async def upload_cv(request: Request):
    try:
        data = await request.json()
        file_name = data.get("fileName")
        file_data = data.get("fileData")
        if not file_name or not file_data:
            raise HTTPException(status_code=400, detail="Missing file info")
            
        buffer = base64.b64decode(file_data)
        os.makedirs("uploads", exist_ok=True)
        relative_path = "./uploads/cv.pdf"
        
        with open(relative_path, "wb") as f:
            f.write(buffer)
            
        return {"path": relative_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/cv-text")
async def get_cv_text():
    try:
        text = ""
        uploaded_txt = "./uploads/cv_text.txt"
        if os.path.exists(uploaded_txt):
            with open(uploaded_txt, "r", encoding="utf-8") as f:
                text = f.read()
        elif os.path.exists("cv_text.txt"):
            with open("cv_text.txt", "r", encoding="utf-8") as f:
                text = f.read()
        return {"text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/cv-text")
async def save_cv_text(request: Request):
    try:
        data = await request.json()
        os.makedirs("uploads", exist_ok=True)
        uploaded_txt = "./uploads/cv_text.txt"
        with open(uploaded_txt, "w", encoding="utf-8") as f:
            f.write(data.get("text", ""))
        return Response(status_code=200)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
@app.get("/api/prompt-template")
async def get_prompt_template(current_user=Depends(get_current_user)):
    try:
        user = Database.get_user(current_user["email"])
        template = user.get("promptTemplate") if user else ""
        if not template and os.path.exists("prompt_template.txt"):
            with open("prompt_template.txt", "r", encoding="utf-8") as f:
                template = f.read()
        return {"template": template}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/prompt-template")
async def save_prompt_template(request: Request, current_user=Depends(get_current_user)):
    try:
        data = await request.json()
        Database.save_user(current_user["email"], {"promptTemplate": data.get("template", "")})
        return Response(status_code=200)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/history")
async def get_history(current_user=Depends(get_current_user)):
    try:
        history = Database.get_outreach_history(current_user["email"])
        return history
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/history")
async def delete_history(current_user=Depends(get_current_user)):
    try:
        Database.clear_outreach_history(current_user["email"])
        return Response(status_code=200)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/upgrade-request")
async def upgrade_request(request: Request, current_user=Depends(get_current_user)):
    try:
        data = await request.json()
        Database.create_upgrade_request(
            current_user["email"],
            {"reason": data.get("reason", "Requested more emails limit")}
        )
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── IMPORTS ENDPOINTS ──

@app.post("/api/imports/upload")
async def upload_import(request: Request, current_user=Depends(get_current_user)):
    try:
        data = await request.json()
        file_name = data.get("fileName")
        file_data = data.get("fileData")
        if not file_name or not file_data:
            raise HTTPException(status_code=400, detail="Missing file info")
            
        buffer = base64.b64decode(file_data)
        sanitized_email = re.sub(r'[^a-zA-Z0-9]', '_', current_user["email"])
        timestamp = int(datetime.datetime.utcnow().timestamp() * 1000)
        sanitized_filename = re.sub(r'[^a-zA-Z0-9.\-_]', '_', file_name)
        
        final_filename = f"{sanitized_email}___{timestamp}___{sanitized_filename}"
        file_path = os.path.join("uploads", "imports", final_filename)
        
        with open(file_path, "wb") as f:
            f.write(buffer)
            
        content = buffer.decode("utf-8", errors="ignore")
        lines = [l.strip() for l in content.split('\n') if l.strip() and not l.strip().startswith('#')]
        
        return {"filename": final_filename, "itemsCount": len(lines)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/imports")
async def get_imports(current_user=Depends(get_current_user)):
    try:
        imports_dir = os.path.join("uploads", "imports")
        if not os.path.exists(imports_dir):
            return []
            
        files = os.listdir(imports_dir)
        sanitized_email = re.sub(r'[^a-zA-Z0-9]', '_', current_user["email"])
        
        user_files = [f for f in files if f.startswith(sanitized_email)]
        results = []
        for file in user_files:
            file_path = os.path.join(imports_dir, file)
            stats = os.stat(file_path)
            
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            lines = [l.strip() for l in content.split('\n') if l.strip() and not l.strip().startswith('#')]
            
            parts = file.split('___')
            name = parts[2] if len(parts) >= 3 else file
            
            results.append({
                "key": file,
                "name": name,
                "uploadedAt": int(stats.st_mtime * 1000),
                "size": stats.st_size,
                "itemsCount": len(lines)
            })
            
        # Sort desc by uploadedAt
        results.sort(key=lambda x: x["uploadedAt"], reverse=True)
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/imports/{filename}")
async def get_import_file(filename: str, current_user=Depends(get_current_user)):
    try:
        sanitized_email = re.sub(r'[^a-zA-Z0-9]', '_', current_user["email"])
        if not filename.startswith(sanitized_email):
            raise HTTPException(status_code=403, detail="Forbidden")
            
        file_path = os.path.join("uploads", "imports", filename)
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="File not found")
            
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
            
        lines = [l.strip() for l in content.split('\n') if l.strip() and not l.strip().startswith('#')]
        return {"content": content, "lines": lines}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/imports/{filename}")
async def delete_import_file(filename: str, current_user=Depends(get_current_user)):
    try:
        sanitized_email = re.sub(r'[^a-zA-Z0-9]', '_', current_user["email"])
        if not filename.startswith(sanitized_email):
            raise HTTPException(status_code=403, detail="Forbidden")
            
        file_path = os.path.join("uploads", "imports", filename)
        if os.path.exists(file_path):
            os.remove(file_path)
        return Response(status_code=200)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── ADMIN ENDPOINTS ──

@app.get("/api/admin/stats")
async def get_admin_stats(current_user=Depends(get_current_admin)):
    try:
        users = Database.get_users()
        candidates = [u for u in users if not is_admin(u["email"])]
        
        total_users = len(candidates)
        total_emails_sent = 0
        total_emails_sent_today = 0
        active_users_count = 0
        
        for u in candidates:
            total_emails_sent += u.get("emailsSentTotal", 0)
            total_emails_sent_today += u.get("emailsSent", 0)
            if u.get("emailsSentTotal", 0) > 0 or u.get("refreshToken") or u.get("cvPath"):
                active_users_count += 1
                
        recent_outreach = Database.get_global_outreach(100)
        upgrade_requests = Database.get_upgrade_requests()
        
        return {
            "totalUsers": total_users,
            "activeUsersCount": active_users_count,
            "totalEmailsSent": total_emails_sent,
            "totalEmailsSentToday": total_emails_sent_today,
            "recentOutreach": recent_outreach,
            "upgradeRequests": upgrade_requests
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/admin/users")
async def get_admin_users(current_user=Depends(get_current_admin)):
    try:
        users = Database.get_users()
        candidates = [u for u in users if not is_admin(u["email"])]
        return candidates
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/admin/update-user-plan")
async def admin_update_user_plan(request: Request, current_user=Depends(get_current_admin)):
    try:
        data = await request.json()
        email = data.get("email")
        plan = data.get("plan")
        if not email or not plan:
            raise HTTPException(status_code=400, detail="Missing email or plan")
            
        updated = Database.save_user(email, {"plan": plan})
        if not updated:
            raise HTTPException(status_code=404, detail="User not found")
        return updated
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/admin/reset-user-usage")
async def admin_reset_user_usage(request: Request, current_user=Depends(get_current_admin)):
    try:
        data = await request.json()
        email = data.get("email")
        if not email:
            raise HTTPException(status_code=400, detail="Missing email")
            
        updated = Database.reset_usage(email)
        if not updated:
            raise HTTPException(status_code=404, detail="User not found")
        return updated
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Helper regex library
import re

# ── STREAMING RUNNER ENDPOINT ──

@app.get("/api/start")
async def start_scraping_stream(
    request: Request,
    urls: str = "",
    max_pages: int = 5,
    test_mode: bool = False
):
    async def sse_event_stream():
        scraper = None
        log_queue = asyncio.Queue()

        def put_log(msg):
            loop = asyncio.get_event_loop()
            loop.call_soon_threadsafe(log_queue.put_nowait, {"type": "log", "content": msg})

        async def run_scraper_task():
            nonlocal scraper
            try:
                run_test_mode = test_mode or (os.environ.get("TEST_MODE", "false").lower() == "true")
                run_max_pages = max_pages
                
                urls_list = []
                if urls:
                    urls_list = [u.strip() for u in urls.split('\n') if u.strip() and not u.strip().startswith('#')]
                if not urls_list:
                    urls_list = [u.strip() for u in os.environ.get("LINKEDIN_TARGET_URLS", "").split('\n') if u.strip() and not u.strip().startswith('#')]
                
                if not urls_list:
                    put_log("Error: No target URLs configured. Set LINKEDIN_TARGET_URLS in .env or paste them in the target box.")
                    return

                mailer = Mailer({
                    "host": os.environ.get("SMTP_HOST", "smtp.gmail.com"),
                    "port": int(os.environ.get("SMTP_PORT", 465)),
                    "user": os.environ.get("SMTP_USER", ""),
                    "pass": os.environ.get("SMTP_PASS", "")
                })

                cv_path = os.environ.get("CV_PATH") or "./uploads/cv.pdf"
                if not os.path.exists(cv_path) and os.path.exists("./my_cv.pdf"):
                    cv_path = "./my_cv.pdf"

                if not os.path.exists(cv_path):
                    put_log(f"Error: CV PDF not found at: {cv_path}. Please upload your CV on the dashboard first.")
                    return

                cv_content = ""
                uploaded_txt = os.path.join("uploads", "cv_text.txt")
                if os.path.exists(uploaded_txt):
                    with open(uploaded_txt, "r", encoding="utf-8") as f:
                        cv_content = f.read()
                elif os.path.exists("cv_text.txt"):
                    with open("cv_text.txt", "r", encoding="utf-8") as f:
                        cv_content = f.read()
                else:
                    put_log("Warning: No parsed CV text found. Email personalization quality may be reduced.")

                ai = AIGenerator(os.environ.get("GROQ_API_KEY", ""))
                processed_emails = set()

                headless_mode = os.environ.get("HEADLESS", "false").lower() == "true"
                put_log(f"Launching browser (display mode: {'headless' if headless_mode else 'visible'})...")
                scraper = LinkedInScraper()
                await scraper.init(headless=headless_mode)

                put_log("Loading LinkedIn session...")
                if run_test_mode:
                    put_log("[TEST MODE] Dry-run active — emails located but NOT sent.")

                async def post_callback(post, emails):
                    urn = post.get("urn")
                    author = post.get("author") or "Unknown Recruiter"
                    text = post.get("text") or ""
                    snippet = text[:150] + "..." if len(text) > 150 else text
                    
                    status = "Pending"
                    if not emails:
                        status = "Skipped"
                    else:
                        status = "Sending"

                    await log_queue.put({
                        "type": "post_progress",
                        "content": {
                            "urn": urn,
                            "author": author,
                            "snippet": snippet,
                            "emails": emails,
                            "status": status
                        }
                    })

                    if emails:
                        for email in emails:
                            email_lower = email.lower()
                            if email_lower in processed_emails:
                                put_log(f"[SKIP] Already processed {email} this session.")
                                continue
                            processed_emails.add(email_lower)
                            
                            put_log(f"Generating personalized email for {email}...")
                            email_content = ai.generate_email(
                                cv_content,
                                text,
                                author,
                                post.get("authorTitle") or "",
                                ""
                            )
                            
                            if not email_content:
                                put_log(f"Error: AI generation failed for {email}.")
                                await log_queue.put({
                                    "type": "post_progress",
                                    "content": {
                                        "urn": urn,
                                        "author": author,
                                        "snippet": snippet,
                                        "emails": emails,
                                        "status": "Failed"
                                    }
                                })
                                continue
                                
                            if run_test_mode:
                                put_log(f"[TEST] Would send to: {email} ({author})")
                                await log_queue.put({
                                    "type": "post_progress",
                                    "content": {
                                        "urn": urn,
                                        "author": author,
                                        "snippet": snippet,
                                        "emails": emails,
                                        "status": "Sent (Test)"
                                    }
                                })
                                continue

                            # Redirect email to test address if set in .env
                            test_recipient = os.environ.get("TEST_EMAIL_RECIPIENT")
                            recipient_email = test_recipient if test_recipient else email
                            
                            if test_recipient:
                                put_log(f"Sending email to {recipient_email} (Redirected from {email} for testing)...")
                            else:
                                put_log(f"Sending email to {email}...")

                            send_result = mailer.send_application(
                                recipient_email,
                                email_content["subject"],
                                email_content["body"],
                                cv_path
                            )
                            
                            if send_result:
                                if test_recipient:
                                    put_log(f"Sent successfully to {recipient_email} (test redirect).")
                                else:
                                    put_log(f"Sent successfully to {email}.")
                                await log_queue.put({
                                    "type": "post_progress",
                                    "content": {
                                        "urn": urn,
                                        "author": author,
                                        "snippet": snippet,
                                        "emails": emails,
                                        "status": "Sent"
                                    }
                                })
                                import random
                                gap = random.randint(10, 20)
                                put_log(f"Rate-limit pause: {gap}s...")
                                await asyncio.sleep(gap)
                            else:
                                put_log(f"Error: Failed to send to {email}.")
                                await log_queue.put({
                                    "type": "post_progress",
                                    "content": {
                                        "urn": urn,
                                        "author": author,
                                        "snippet": snippet,
                                        "emails": emails,
                                        "status": "Failed"
                                    }
                                })

                for url in urls_list:
                    put_log(f"Scraping URL: {url}")
                    await scraper.scrape_posts_from_url(url, put_log, post_callback, run_max_pages)
                    
                put_log("Automation complete.")
            except asyncio.CancelledError:
                put_log("Automation terminated by user.")
            except Exception as e:
                put_log(f"Fatal error: {str(e)}")
            finally:
                if scraper:
                    await scraper.close()
                await log_queue.put({"type": "done", "content": None})

        # Start background task
        task = asyncio.create_task(run_scraper_task())
        running_tasks.add(task)
        task.add_done_callback(running_tasks.discard)

        # Yield events from the queue
        while True:
            item = await log_queue.get()
            t = item["type"]
            c = item["content"]
            if t == "log":
                yield f"data: {json.dumps({'type': 'log', 'content': c})}\n\n"
            elif t == "post_progress":
                yield f"data: {json.dumps({'type': 'post_progress', 'content': c})}\n\n"
            elif t == "done":
                yield "data: [DONE]\n\n"
                break

    return StreamingResponse(sse_event_stream(), media_type="text/event-stream")

@app.post("/api/stop")
async def stop_scraping():
    for task in list(running_tasks):
        task.cancel()
    running_tasks.clear()
    return {"success": True}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, log_level="info")
