// 🚨 Ensure dotenv is the first thing loaded
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');

// Mongoose Models
const Transaction = require('./models/Transaction'); 
const User = require('./models/User'); 

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

// --- MongoDB Connection ---
mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => {
        console.error('MongoDB connection error:', err.message);
        process.exit(1); 
    });

// --- Constants ---
const CATEGORIES = [
    'Food', 'Transport', 'Bills', 'Shopping', 'Salary', 'Investment', 'Other'
];

// --- Session & Middleware Configuration ---

app.use(session({
    // In production, use a strong, random string from process.env.SESSION_SECRET
    secret: 'a-very-secret-key-for-fintrack', 
    resave: false,
    saveUninitialized: true,
    // Store sessions in MongoDB so they persist across server restarts
    store: MongoStore.create({ mongoUrl: MONGO_URI }),
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24 // 1 day 
    }
}));

app.set('view engine', 'ejs');
app.set('views', 'views');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
    if (req.session.userId) {
        return next();
    }
    res.redirect('/login?error=' + encodeURIComponent('Please log in to view the dashboard.'));
}

// Helper: Email Validator (Regex)
function validateEmail(email) {
    // Basic regex for email validation (checks for @ and domain extension)
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(String(email).toLowerCase());
}

// Helper: Financial Summary from a list of transactions
const calculateSummary = (transactions) => {
    const income = transactions
        .filter(t => t.type === 'income')
        .reduce((sum, t) => sum + t.amount, 0);
    const expense = transactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + t.amount, 0);
    const net = income - expense;
    return { income, expense, net };
};

// Helper: Formatters
const formatters = {
    currency: (amount) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount),
    date: (date) => new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
};


// ==================================================================
// AUTHENTICATION ROUTES
// ==================================================================

// GET /register - Show registration form
app.get('/register', (req, res) => {
    res.render('register', { error: req.query.error });
});

// POST /register - Handle new user creation
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    
    // 1. Validate Email Format (Server-side check)
    if (!validateEmail(email)) {
        return res.redirect('/register?error=' + encodeURIComponent('Please enter a valid email address format.'));
    }

    try {
        // 2. Check if Email Exists in Database
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.redirect('/register?error=' + encodeURIComponent('This email is already registered. Please login.'));
        }
        
        // Password hashing is handled automatically by the User model's pre-save middleware
        const newUser = new User({ name, email, password });
        await newUser.save();

        // Auto-login after registration
        req.session.userId = newUser._id;
        res.redirect('/');
    } catch (err) {
        console.error('Registration error:', err);
        res.redirect('/register?error=' + encodeURIComponent(err.message || 'Registration failed.'));
    }
});

// GET /login - Show login form
app.get('/login', (req, res) => {
    res.render('login', { error: req.query.error });
});

// POST /login - Handle login logic
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    // 1. Validate Email Format
    if (!validateEmail(email)) {
        return res.redirect('/login?error=' + encodeURIComponent('Invalid email format.'));
    }

    try {
        const user = await User.findOne({ email });
        
        // 2. Check User Existence & Password
        if (user && (await user.matchPassword(password))) {
            req.session.userId = user._id;
            res.redirect('/');
        } else {
            // Ambiguous message for security, but implies email might not exist or password wrong
            res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
        }
    } catch (err) {
        console.error('Login error:', err);
        res.redirect('/login?error=' + encodeURIComponent('Login failed.'));
    }
});

// GET /logout - Destroy session
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
            return res.redirect('/');
        }
        res.redirect('/login?error=' + encodeURIComponent('Successfully logged out.'));
    });
});


// ==================================================================
// DASHBOARD & TRANSACTION ROUTES (PROTECTED)
// ==================================================================

// GET / - Main Dashboard (includes Filtering & Monthly Breakdown)
app.get('/', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const currentUser = await User.findById(userId);

        // --- 1. Build Filter Object ---
        let filter = { userId: userId };
        const queryParams = req.query;

        // Month Filter (Format: YYYY-MM)
        if (queryParams.month && queryParams.month !== 'all') {
            const [year, month] = queryParams.month.split('-');
            const startDate = new Date(year, parseInt(month) - 1, 1);
            const endDate = new Date(year, parseInt(month), 0); // Last day of month

            filter.date = { 
                $gte: startDate, 
                $lte: endDate 
            };
        }

        // Category Filter
        if (queryParams.category && queryParams.category !== 'all') {
            filter.category = queryParams.category;
        }

        // --- 2. Fetch Filtered Transactions ---
        const transactions = await Transaction.find(filter).sort({ date: -1, createdAt: -1 });
        const summary = calculateSummary(transactions);

        // --- 3. Monthly Breakdown Aggregation (Last 12 Months for Chart) ---
        // Calculate the date 11 months ago (to cover 12 months including the current one)
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
        twelveMonthsAgo.setDate(1);

        const monthlyData = await Transaction.aggregate([
            { 
                $match: { 
                    userId: new mongoose.Types.ObjectId(userId), // Ensure ObjectId type
                    date: { $gte: twelveMonthsAgo }
                } 
            },
            { 
                $group: {
                    _id: { 
                        year: { $year: "$date" }, 
                        month: { $month: "$date" } 
                    },
                    totalIncome: { 
                        $sum: { 
                            $cond: [{ $eq: ["$type", "income"] }, "$amount", 0] 
                        } 
                    },
                    totalExpense: { 
                        $sum: { 
                            $cond: [{ $eq: ["$type", "expense"] }, "$amount", 0] 
                        } 
                    }
                } 
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } }
        ]);
        
        // Format aggregation results for the Chart.js and the List view
        const monthlyBreakdown = monthlyData.map(data => {
            const date = new Date(data._id.year, data._id.month - 1);
            return {
                label: date.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
                income: data.totalIncome,
                expense: data.totalExpense,
                net: data.totalIncome - data.totalExpense,
                monthKey: `${data._id.year}-${String(data._id.month).padStart(2, '0')}` // YYYY-MM format
            };
        });

        // --- 4. Render View ---
        res.render('index', {
            transactions,
            summary,
            monthlyBreakdown, // Data for both list and chart
            categories: CATEGORIES,
            currentUser: currentUser,
            editTransaction: null, 
            error: req.query.error,
            formatCurrency: formatters.currency,
            formatDate: formatters.date,
            query: queryParams, // Pass filters back to UI to maintain state
        });

    } catch (err) {
        console.error('Error fetching data:', err);
        res.status(500).send(`Server Error: ${err.message}`);
    }
});

// POST /add - Add new transaction
app.post('/add', isAuthenticated, async (req, res) => {
    const { type, category, amount, note, date } = req.body;

    if (!type || !category || !amount || !date) {
        return res.redirect('/?error=' + encodeURIComponent('Missing required fields.'));
    }
    
    try {
        const newTransaction = new Transaction({
            userId: req.session.userId, 
            type,
            category,
            amount: parseFloat(amount),
            note,
            date: new Date(date)
        });
        await newTransaction.save();
        res.redirect('/');
    } catch (err) {
        console.error('Error saving transaction:', err);
        res.redirect(`/?error=${encodeURIComponent(err.message)}`);
    }
});

// GET /edit/:id - Load data into form for editing
app.get('/edit/:id', isAuthenticated, async (req, res) => {
    try {
        // Find transaction belonging to this user
        const editTransaction = await Transaction.findOne({ _id: req.params.id, userId: req.session.userId });
        
        if (!editTransaction) {
            return res.status(404).send('Transaction not found or unauthorized.');
        }
        
        // We still need to load the list for the bottom part of the page
        const transactions = await Transaction.find({ userId: req.session.userId }).sort({ date: -1, createdAt: -1 });
        const summary = calculateSummary(transactions);

        res.render('index', {
            transactions,
            summary,
            monthlyBreakdown: [], // Skipping complex aggregation on edit page load
            categories: CATEGORIES,
            currentUser: await User.findById(req.session.userId),
            editTransaction: editTransaction, 
            error: req.query.error,
            formatCurrency: formatters.currency,
            formatDate: formatters.date,
            query: {}, 
        });

    } catch (err) {
        console.error('Error loading edit page:', err);
        res.status(500).send('Server Error');
    }
});


// POST /update/:id - Update existing transaction
app.post('/update/:id', isAuthenticated, async (req, res) => {
    const { type, category, amount, note, date } = req.body;

    try {
        const updated = await Transaction.findOneAndUpdate(
            { _id: req.params.id, userId: req.session.userId },
            {
                type,
                category,
                amount: parseFloat(amount),
                note,
                date: new Date(date)
            }
        );

        if (!updated) return res.redirect(`/?error=${encodeURIComponent('Update failed.')}`);
        
        res.redirect('/');
    } catch (err) {
        console.error('Error updating:', err);
        res.redirect(`/?error=${encodeURIComponent(err.message)}`);
    }
});

// POST /delete/:id - Delete transaction
app.post('/delete/:id', isAuthenticated, async (req, res) => {
    try {
        const deleted = await Transaction.findOneAndDelete({ _id: req.params.id, userId: req.session.userId });
        if (!deleted) return res.redirect(`/?error=${encodeURIComponent('Delete failed.')}`);

        res.redirect('/');
    } catch (err) {
        console.error('Error deleting:', err);
        res.redirect(`/?error=${encodeURIComponent(err.message)}`);
    }
});

// GET /export/csv - Export data to CSV
app.get('/export/csv', isAuthenticated, async (req, res) => {
    try {
        const transactions = await Transaction.find({ userId: req.session.userId }).sort({ date: 1 });
        
        if (transactions.length === 0) {
            return res.redirect('/?error=' + encodeURIComponent('No transactions to export.'));
        }

        // CSV Construction
        let csv = 'Date,Type,Category,Amount,Note,Created At\n';

        transactions.forEach(t => {
            csv += [
                formatters.date(t.date),
                t.type.toUpperCase(),
                `"${t.category.replace(/"/g, '""')}"`, // Escape quotes
                t.amount.toFixed(2),
                `"${t.note.replace(/"/g, '""')}"`, // Escape quotes
                formatters.date(t.createdAt)
            ].join(',') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="fintrack_export.csv"');
        res.status(200).send(csv);

    } catch (err) {
        console.error('CSV Export Error:', err);
        res.redirect('/?error=' + encodeURIComponent('Failed to export.'));
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});