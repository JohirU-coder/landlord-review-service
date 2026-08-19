require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const Joi = require('joi');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { saveBase64Photo, PHOTOS_DIR } = require('./photoStorage');

const app = express();
const PORT = process.env.PORT || 3003;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// JWT auth — matches auth-service's generateToken() exactly (same JWT_SECRET,
// same payload shape: { id, email, role, firstName, lastName, email_verified }).
// reviewer_id/landlord_id are derived from the token instead of trusting
// client-supplied values.
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access denied', message: 'No token provided' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token', message: 'Token is invalid or expired' });
    }
    req.user = user;
    next();
  });
};

const requireRole = (roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      error: 'Insufficient permissions',
      message: `This endpoint requires ${roles.join(' or ')} role`
    });
  }
  next();
};

// Validation schema for review creation — reviewer_id is no longer accepted
// from the client; it's derived from the authenticated user's token.
const createReviewSchema = Joi.object({
  property_id: Joi.number().integer().required(),
  overall_rating: Joi.number().integer().min(1).max(5).required(),
  communication_rating: Joi.number().integer().min(1).max(5).required(),
  maintenance_rating: Joi.number().integer().min(1).max(5).required(),
  property_condition_rating: Joi.number().integer().min(1).max(5).required(),
  value_rating: Joi.number().integer().min(1).max(5).required(),
  title: Joi.string().required().min(10).max(200),
  review_text: Joi.string().required().min(50).max(2000),
  move_in_date: Joi.date().max('now'),
  move_out_date: Joi.date().min(Joi.ref('move_in_date')).allow(null),
  would_recommend: Joi.boolean().required(),
  anonymous: Joi.boolean().default(false),
  // Up to 2 photos, sent as base64 data URLs (data:image/jpeg;base64,...)
  photos: Joi.array().items(Joi.string()).max(2).default([])
});

// Validation schema for landlord response — landlord_id derived from token.
const landlordResponseSchema = Joi.object({
  response_text: Joi.string().required().min(20).max(1000)
});

// Validation schema for review search
const searchReviewsSchema = Joi.object({
  property_id: Joi.number().integer(),
  landlord_id: Joi.number().integer(),
  min_rating: Joi.number().integer().min(1).max(5),
  max_rating: Joi.number().integer().min(1).max(5).min(Joi.ref('min_rating')),
  sort_by: Joi.string().valid('newest', 'oldest', 'rating_high', 'rating_low', 'most_helpful'),
  limit: Joi.number().integer().min(1).max(50).default(20),
  offset: Joi.number().integer().min(0).default(0)
});

app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
    'https://rentreviews.net',
    'https://www.rentreviews.net'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
// Higher limit than the 100kb default — request bodies can carry up to 2
// base64-encoded photos (~13.3MB each once base64-inflated from 10MB raw).
app.use(express.json({ limit: '30mb' }));
// Serve uploaded review photos from the Railway volume mounted at PHOTOS_DIR.
app.use('/photos', express.static(PHOTOS_DIR));

// Gates schema-setup/admin endpoints -- matches auth-service's pattern.
const requireAdminSecret = (req, res, next) => {
  const secret = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
  }
  next();
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'review-service',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Landlord Review Service API',
    status: 'running',
    endpoints: {
      health: '/health',
      'setup-database': '/setup-database (GET)',
      'create-review': '/reviews (POST)',
      'get-reviews': '/reviews (GET)',
      'landlord-response': '/reviews/:id/response (POST)',
      'review-stats': '/reviews/stats (GET)',
      test: '/test'
    }
  });
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({
    message: 'Review service test endpoint working!',
    database: process.env.DATABASE_URL ? 'Connected' : 'Not configured',
    port: PORT
  });
});

// Database setup endpoint
app.get('/setup-database', requireAdminSecret, async (req, res) => {
  try {
    // Create reviews table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
        reviewer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        overall_rating INTEGER NOT NULL CHECK (overall_rating >= 1 AND overall_rating <= 5),
        communication_rating INTEGER NOT NULL CHECK (communication_rating >= 1 AND communication_rating <= 5),
        maintenance_rating INTEGER NOT NULL CHECK (maintenance_rating >= 1 AND maintenance_rating <= 5),
        property_condition_rating INTEGER NOT NULL CHECK (property_condition_rating >= 1 AND property_condition_rating <= 5),
        value_rating INTEGER NOT NULL CHECK (value_rating >= 1 AND value_rating <= 5),
        title VARCHAR(200) NOT NULL,
        review_text TEXT NOT NULL,
        move_in_date DATE,
        move_out_date DATE,
        would_recommend BOOLEAN NOT NULL,
        anonymous BOOLEAN DEFAULT FALSE,
        verified BOOLEAN DEFAULT FALSE,
        helpful_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create landlord responses table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS landlord_responses (
        id SERIAL PRIMARY KEY,
        review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
        landlord_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        response_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(review_id)
      );
    `);

    // Create review helpfulness table (for future use)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS review_helpfulness (
        id SERIAL PRIMARY KEY,
        review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        is_helpful BOOLEAN NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(review_id, user_id)
      );
    `);

    // Create review photos table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS review_photos (
        id SERIAL PRIMARY KEY,
        review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    res.json({
      message: 'Review service database tables created successfully!',
      tables: ['reviews', 'landlord_responses', 'review_helpfulness', 'review_photos'],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Database setup error:', error);
    res.status(500).json({ 
      error: 'Failed to create review tables', 
      details: error.message 
    });
  }
});

// POST /reviews - Create a new review (requires renter auth)
app.post('/reviews', authenticateToken, requireRole(['renter']), async (req, res) => {
  try {
    // Validate request body
    const { error, value } = createReviewSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(detail => detail.message)
      });
    }

    const {
      property_id,
      overall_rating,
      communication_rating,
      maintenance_rating,
      property_condition_rating,
      value_rating,
      title,
      review_text,
      move_in_date,
      move_out_date,
      would_recommend,
      anonymous,
      photos
    } = value;

    const reviewer_id = req.user.id;

    // Verify property exists
    const propertyCheck = await pool.query(
      'SELECT id, landlord_id FROM properties WHERE id = $1',
      [property_id]
    );

    if (propertyCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'The specified property does not exist'
      });
    }

    if (propertyCheck.rows[0].landlord_id === reviewer_id) {
      return res.status(403).json({
        error: 'Cannot review own property',
        message: 'You cannot review your own property'
      });
    }

    // Check for duplicate review (same reviewer + property)
    const duplicateCheck = await pool.query(
      'SELECT id FROM reviews WHERE property_id = $1 AND reviewer_id = $2',
      [property_id, reviewer_id]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(409).json({
        error: 'Review already exists',
        message: 'You have already reviewed this property',
        existing_review_id: duplicateCheck.rows[0].id
      });
    }

    // Insert the new review
    const insertQuery = `
      INSERT INTO reviews (
        property_id, reviewer_id, overall_rating, communication_rating, 
        maintenance_rating, property_condition_rating, value_rating,
        title, review_text, move_in_date, move_out_date, would_recommend, anonymous
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `;

    const result = await pool.query(insertQuery, [
      property_id, reviewer_id, overall_rating, communication_rating,
      maintenance_rating, property_condition_rating, value_rating,
      title, review_text, move_in_date, move_out_date, would_recommend, anonymous
    ]);

    const newReview = result.rows[0];

    // Save photos (best-effort — an invalid/oversized photo is skipped, not
    // a reason to fail the whole review submission).
    const photoUrls = [];
    for (const photo of photos) {
      const filename = saveBase64Photo(photo);
      if (!filename) continue;

      await pool.query(
        'INSERT INTO review_photos (review_id, filename) VALUES ($1, $2)',
        [newReview.id, filename]
      );
      photoUrls.push(`/photos/${filename}`);
    }

    res.status(201).json({
      success: true,
      message: 'Review created successfully',
      review: {
        id: newReview.id,
        property_id: newReview.property_id,
        overall_rating: newReview.overall_rating,
        ratings: {
          communication: newReview.communication_rating,
          maintenance: newReview.maintenance_rating,
          property_condition: newReview.property_condition_rating,
          value: newReview.value_rating
        },
        title: newReview.title,
        review_text: newReview.review_text,
        move_in_date: newReview.move_in_date,
        move_out_date: newReview.move_out_date,
        would_recommend: newReview.would_recommend,
        anonymous: newReview.anonymous,
        verified: newReview.verified,
        photos: photoUrls,
        helpful_count: newReview.helpful_count,
        created_at: newReview.created_at
      }
    });

  } catch (error) {
    console.error('Error creating review:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create review'
    });
  }
});

// GET /reviews - Search and filter reviews
app.get('/reviews', async (req, res) => {
  try {
    // Validate query parameters
    const { error, value } = searchReviewsSchema.validate(req.query);
    if (error) {
      return res.status(400).json({
        error: 'Invalid search parameters',
        details: error.details.map(detail => detail.message)
      });
    }

    const {
      property_id,
      landlord_id,
      min_rating,
      max_rating,
      sort_by = 'newest',
      limit = 20,
      offset = 0
    } = value;

    // Build dynamic WHERE clause
    let whereConditions = [];
    let queryParams = [];
    let paramCount = 0;

    if (property_id) {
      paramCount++;
      whereConditions.push(`r.property_id = $${paramCount}`);
      queryParams.push(property_id);
    }

    if (landlord_id) {
      paramCount++;
      whereConditions.push(`p.landlord_id = $${paramCount}`);
      queryParams.push(landlord_id);
    }

    if (min_rating) {
      paramCount++;
      whereConditions.push(`r.overall_rating >= $${paramCount}`);
      queryParams.push(min_rating);
    }

    if (max_rating) {
      paramCount++;
      whereConditions.push(`r.overall_rating <= $${paramCount}`);
      queryParams.push(max_rating);
    }

    const whereClause = whereConditions.length > 0 
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Build ORDER BY clause
    let orderClause;
    switch (sort_by) {
      case 'oldest':
        orderClause = 'ORDER BY r.created_at ASC';
        break;
      case 'rating_high':
        orderClause = 'ORDER BY r.overall_rating DESC, r.created_at DESC';
        break;
      case 'rating_low':
        orderClause = 'ORDER BY r.overall_rating ASC, r.created_at DESC';
        break;
      case 'most_helpful':
        orderClause = 'ORDER BY r.helpful_count DESC, r.created_at DESC';
        break;
      case 'newest':
      default:
        orderClause = 'ORDER BY r.created_at DESC';
        break;
    }

    // Add pagination parameters
    paramCount++;
    const limitParam = `$${paramCount}`;
    queryParams.push(limit);
    
    paramCount++;
    const offsetParam = `$${paramCount}`;
    queryParams.push(offset);

    // Main search query
    const searchQuery = `
      SELECT 
        r.*,
        p.address,
        p.city,
        p.state,
        u.first_name as reviewer_first_name,
        u.last_name as reviewer_last_name,
        lr.response_text as landlord_response,
        lr.created_at as response_created_at
      FROM reviews r
      JOIN properties p ON r.property_id = p.id
      LEFT JOIN users u ON r.reviewer_id = u.id AND r.anonymous = false
      LEFT JOIN landlord_responses lr ON r.id = lr.review_id
      ${whereClause}
      ${orderClause}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    // Count query for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM reviews r
      JOIN properties p ON r.property_id = p.id
      ${whereClause}
    `;

    const [searchResult, countResult] = await Promise.all([
      pool.query(searchQuery, queryParams),
      pool.query(countQuery, queryParams.slice(0, -2))
    ]);

    const reviews = searchResult.rows;
    const totalCount = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalCount / limit);
    const currentPage = Math.floor(offset / limit) + 1;

    // Fetch photos for these reviews in one extra query (kept separate from
    // the main join above to avoid disturbing its existing GROUP-BY-free shape).
    const photosByReview = {};
    if (reviews.length > 0) {
      const photosResult = await pool.query(
        'SELECT review_id, filename FROM review_photos WHERE review_id = ANY($1) ORDER BY created_at ASC',
        [reviews.map(r => r.id)]
      );
      photosResult.rows.forEach(p => {
        if (!photosByReview[p.review_id]) photosByReview[p.review_id] = [];
        photosByReview[p.review_id].push(`/photos/${p.filename}`);
      });
    }

    // Format response
    const formattedReviews = reviews.map(review => ({
      id: review.id,
      property: {
        id: review.property_id,
        address: review.address,
        city: review.city,
        state: review.state
      },
      reviewer: review.anonymous ? null : {
        first_name: review.reviewer_first_name,
        last_name: review.reviewer_last_name
      },
      photos: photosByReview[review.id] || [],
      ratings: {
        overall: review.overall_rating,
        communication: review.communication_rating,
        maintenance: review.maintenance_rating,
        property_condition: review.property_condition_rating,
        value: review.value_rating
      },
      title: review.title,
      review_text: review.review_text,
      move_in_date: review.move_in_date,
      move_out_date: review.move_out_date,
      would_recommend: review.would_recommend,
      anonymous: review.anonymous,
      verified: review.verified,
      helpful_count: review.helpful_count,
      created_at: review.created_at,
      landlord_response: review.landlord_response ? {
        text: review.landlord_response,
        created_at: review.response_created_at
      } : null
    }));

    res.json({
      success: true,
      reviews: formattedReviews,
      pagination: {
        total_count: totalCount,
        total_pages: totalPages,
        current_page: currentPage,
        limit: limit,
        offset: offset,
        has_next: currentPage < totalPages,
        has_previous: currentPage > 1
      }
    });

  } catch (error) {
    console.error('Error searching reviews:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to search reviews'
    });
  }
});

// POST /reviews/:id/response - Landlord response to review (requires landlord auth)
app.post('/reviews/:id/response', authenticateToken, requireRole(['landlord']), async (req, res) => {
  try {
    const reviewId = parseInt(req.params.id);

    if (isNaN(reviewId)) {
      return res.status(400).json({
        error: 'Invalid review ID',
        message: 'Review ID must be a number'
      });
    }

    // Validate request body
    const { error, value } = landlordResponseSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(detail => detail.message)
      });
    }

    const { response_text } = value;
    const landlord_id = req.user.id;

    // Verify review exists and get property info
    const reviewCheck = await pool.query(`
      SELECT r.id, p.landlord_id as property_landlord_id
      FROM reviews r
      JOIN properties p ON r.property_id = p.id
      WHERE r.id = $1
    `, [reviewId]);

    if (reviewCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'Review not found',
        message: 'The specified review does not exist'
      });
    }

    // Verify landlord owns the property
    if (reviewCheck.rows[0].property_landlord_id !== landlord_id) {
      return res.status(403).json({
        error: 'Unauthorized',
        message: 'Only the property owner can respond to this review'
      });
    }

    // Check if response already exists
    const existingResponse = await pool.query(
      'SELECT id FROM landlord_responses WHERE review_id = $1',
      [reviewId]
    );

    if (existingResponse.rows.length > 0) {
      return res.status(409).json({
        error: 'Response already exists',
        message: 'A response to this review already exists'
      });
    }

    // Insert the response
    const insertQuery = `
      INSERT INTO landlord_responses (review_id, landlord_id, response_text)
      VALUES ($1, $2, $3)
      RETURNING *
    `;

    const result = await pool.query(insertQuery, [reviewId, landlord_id, response_text]);
    const newResponse = result.rows[0];

    res.status(201).json({
      success: true,
      message: 'Response added successfully',
      response: {
        id: newResponse.id,
        review_id: newResponse.review_id,
        response_text: newResponse.response_text,
        created_at: newResponse.created_at
      }
    });

  } catch (error) {
    console.error('Error creating landlord response:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create response'
    });
  }
});

// GET /reviews/stats - Review statistics
app.get('/reviews/stats', async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_reviews,
        COUNT(CASE WHEN verified = true THEN 1 END) as verified_reviews,
        AVG(overall_rating) as avg_overall_rating,
        AVG(communication_rating) as avg_communication_rating,
        AVG(maintenance_rating) as avg_maintenance_rating,
        AVG(property_condition_rating) as avg_property_condition_rating,
        AVG(value_rating) as avg_value_rating,
        COUNT(CASE WHEN would_recommend = true THEN 1 END) as would_recommend_count,
        COUNT(CASE WHEN anonymous = true THEN 1 END) as anonymous_reviews,
        COUNT(DISTINCT property_id) as properties_reviewed
      FROM reviews
    `;

    const result = await pool.query(statsQuery);
    const stats = result.rows[0];

    res.json({
      success: true,
      statistics: {
        total_reviews: parseInt(stats.total_reviews),
        verified_reviews: parseInt(stats.verified_reviews),
        verification_rate: stats.total_reviews > 0 
          ? Math.round((stats.verified_reviews / stats.total_reviews) * 100) 
          : 0,
        average_ratings: {
          overall: stats.avg_overall_rating ? Math.round(parseFloat(stats.avg_overall_rating) * 10) / 10 : null,
          communication: stats.avg_communication_rating ? Math.round(parseFloat(stats.avg_communication_rating) * 10) / 10 : null,
          maintenance: stats.avg_maintenance_rating ? Math.round(parseFloat(stats.avg_maintenance_rating) * 10) / 10 : null,
          property_condition: stats.avg_property_condition_rating ? Math.round(parseFloat(stats.avg_property_condition_rating) * 10) / 10 : null,
          value: stats.avg_value_rating ? Math.round(parseFloat(stats.avg_value_rating) * 10) / 10 : null
        },
        recommendation_rate: stats.total_reviews > 0 
          ? Math.round((stats.would_recommend_count / stats.total_reviews) * 100) 
          : 0,
        anonymous_rate: stats.total_reviews > 0 
          ? Math.round((stats.anonymous_reviews / stats.total_reviews) * 100) 
          : 0,
        properties_reviewed: parseInt(stats.properties_reviewed)
      }
    });

  } catch (error) {
    console.error('Error fetching review statistics:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch review statistics'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⭐ Review service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});