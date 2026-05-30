import { Router } from 'express'
import { registerUser, loginUser, refreshAccessToken, logoutUser, getUserProfile } from '../services/authService.js'
import { authenticate } from '../middleware/authenticate.js'


const router = Router()


router.post('/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required: email, password, firstName, lastName'
      })
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters long'
      })
    }

    const result = await registerUser({ email, password, firstName, lastName })

    console.log(`[AUTH API] User registered successfully: ${email}`)

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken
    })
  } catch (error) {
    if (error.status === 409) {
      return res.status(409).json({ success: false, error: error.message })
    }
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({
        success: false,
        error: error.errors.map((e) => e.message).join(', ')
      })
    }
    console.error('Signup error:', error)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})


router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      })
    }

    const result = await loginUser({ email, password })

    console.log(`[AUTH API] User logged in successfully: ${email}`)

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken
    })
  } catch (error) {
    if (error.status === 401) {
      return res.status(401).json({ success: false, error: error.message })
    }
    console.error('Login error:', error)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})


router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Refresh token is required'
      })
    }

    const result = await refreshAccessToken(refreshToken)

    console.log(`[AUTH API] Access token refreshed successfully`)

    return res.status(200).json({
      success: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken
    })
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, error: error.message })
    }
    console.error('Token refresh error:', error)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})


router.post('/logout', authenticate, async (req, res) => {
  try {
    const accessToken = req.accessToken
    const refreshToken = req.body?.refreshToken

    await logoutUser(accessToken, refreshToken)

    console.log(`[AUTH API] User logged out successfully`)

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    })
  } catch (error) {
    console.error('Logout error:', error)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})


router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await getUserProfile(req.user.userId)

    console.log(`[AUTH API] Profile fetched successfully for user ID: ${req.user.userId}`)

    return res.status(200).json({
      success: true,
      user
    })
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ success: false, error: error.message })
    }
    console.error('Profile fetch error:', error)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

export default router
