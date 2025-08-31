// IPO_MAALIK_BE/controllers/authController.js
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const loginPool = require("../db_auth"); // <-- Using the new login database pool

// Configure Nodemailer with your Brevo (Sendinblue) SMTP credentials
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  auth: {
    user: process.env.BREVO_SMTP_LOGIN,
    pass: process.env.BREVO_SMTP_KEY,
  },
});

// --- Function to send OTP ---
exports.sendOtp = async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

  try {
    // Save the OTP to the 'otps' table
    await loginPool.query( // <-- Using loginPool
      `INSERT INTO otps (email, otp_code, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET otp_code = $2, expires_at = $3;`,
      [email, otpCode, expiresAt]
    );

    // Send the email
    await transporter.sendMail({
      from: process.env.EMAIL_SENDER,
      to: email,
      subject: 'Your IPO Maalik Login OTP',
      html: `<p>Your One-Time Password is: <strong>${otpCode}</strong></p>
             <p>This code is valid for 10 minutes.</p>`,
    });

    res.status(200).json({ message: 'OTP sent successfully.' });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({ message: 'Error sending OTP.' });
  }
};

// --- Function to verify OTP and login/register ---
exports.verifyOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ message: 'Email and OTP are required' });
  }

  try {
    const otpResult = await loginPool.query( // <-- Using loginPool
      'SELECT otp_code, expires_at FROM otps WHERE email = $1',
      [email]
    );
    const otpRecord = otpResult.rows[0];

    if (!otpRecord || otpRecord.otp_code !== otp || new Date() > otpRecord.expires_at) {
      await loginPool.query('DELETE FROM otps WHERE email = $1', [email]); // <-- Using loginPool
      return res.status(400).json({ message: 'Invalid or expired OTP.' });
    }

    // Check if user exists
    const userResult = await loginPool.query('SELECT id, name FROM users WHERE email = $1', [email]); // <-- Using loginPool
    const existingUser = userResult.rows[0];

    if (!existingUser) {
      await loginPool.query('DELETE FROM otps WHERE email = $1', [email]); // <-- Using loginPool
      return res.status(200).json({ isNewUser: true });
    }

    // User exists, generate tokens
    await loginPool.query('DELETE FROM otps WHERE email = $1', [email]); // <-- Using loginPool
    const accessToken = jwt.sign({ userId: existingUser.id }, process.env.JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ userId: existingUser.id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '20d' });

    res.status(200).json({
      message: `Welcome back, ${existingUser.name}!`,
      isNewUser: false,
      user: { id: existingUser.id, name: existingUser.name, email },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ message: 'Error verifying OTP.' });
  }
};

// --- Function to register a new user ---
exports.registerUser = async (req, res) => {
  const { email, name } = req.body;
  if (!email || !name) {
    return res.status(400).json({ message: 'Email and name are required' });
  }

  try {
    const newUser = await loginPool.query( // <-- Using loginPool
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id',
      [email, name]
    );

    const userId = newUser.rows[0].id;
    const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: '20d' });

    res.status(201).json({
      message: `Hello, ${name}! Your account has been created.`,
      user: { id: userId, name, email },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({ message: 'Error registering user.' });
  }
};