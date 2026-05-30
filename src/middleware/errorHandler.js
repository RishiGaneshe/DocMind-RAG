export const errorHandler = (err, req, res, next) => {
  console.error(err)
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal Server Error'
    }
  })
}
