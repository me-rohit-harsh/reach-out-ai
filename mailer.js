const nodemailer = require('nodemailer');

class Mailer {
  constructor(config) {
    if (config.type === 'OAuth2') {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: config.user,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken
        },
        debug: true,
        logger: true
      });
    } else {
      this.transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.port === 465,
        auth: {
          user: config.user,
          pass: config.pass
        },
        debug: true,
        logger: true
      });
    }
  }

  async sendApplication(to, subject, body, cvPath) {
    const fromAddress = this.transporter.options.auth.user;
    const mailOptions = {
      from: fromAddress,
      to,
      subject,
      text: body,
      attachments: [
        {
          path: cvPath
        }
      ]
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log('Email sent: ' + info.response);
      return info;
    } catch (error) {
      console.error('Error sending email:', error.message);
      return null;
    }
  }
}

module.exports = Mailer;
