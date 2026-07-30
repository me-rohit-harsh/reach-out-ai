import smtplib
import base64
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
import os

class Mailer:
    def __init__(self, config):
        self.config = config
        self.type = config.get('type')
        self.user = config.get('user')
        
    def send_application(self, to, subject, body, cv_path):
        from_address = self.user
        
        # Create message container
        msg = MIMEMultipart()
        msg['From'] = from_address
        msg['To'] = to
        msg['Subject'] = subject
        
        # Attach email body text
        msg.attach(MIMEText(body, 'html', 'utf-8'))
        
        # Attach CV file if exists
        if cv_path and os.path.exists(cv_path):
            filename = os.path.basename(cv_path)
            try:
                with open(cv_path, 'rb') as attachment:
                    part = MIMEBase('application', 'octet-stream')
                    part.set_payload(attachment.read())
                    encoders.encode_base64(part)
                    part.add_header(
                        'Content-Disposition',
                        f'attachment; filename="{filename}"',
                    )
                    msg.attach(part)
            except Exception as e:
                print(f"Error attaching CV file: {str(e)}")
        
        try:
            # Connect to SMTP server
            host = self.config.get('host', 'smtp.gmail.com')
            port = int(self.config.get('port', 465))
            
            if port == 465:
                server = smtplib.SMTP_SSL(host, port, timeout=15)
            else:
                server = smtplib.SMTP(host, port, timeout=15)
                server.ehlo()
                try:
                    server.starttls()
                    server.ehlo()
                except Exception:
                    pass  # TLS not supported or already encrypted
            
            # Authenticate
            if self.type == 'OAuth2':
                # Format XOAUTH2 credentials payload
                auth_str = f"user={self.user}\x01auth=Bearer {self.config.get('accessToken')}\x01\x01"
                auth_b64 = base64.b64encode(auth_str.encode('utf-8')).decode('utf-8')
                
                # Send AUTH XOAUTH2 command
                code, resp = server.docmd("AUTH", "XOAUTH2 " + auth_b64)
                if code != 235:
                    raise Exception(f"XOAUTH2 Authentication failed: {code} {resp.decode('utf-8', errors='ignore')}")
            else:
                server.login(self.user, self.config.get('pass'))
                
            # Send message
            server.sendmail(from_address, [to], msg.as_string())
            server.quit()
            print(f"Email sent successfully to {to}")
            return True
        except Exception as e:
            print("Error sending email:", str(e))
            return False
