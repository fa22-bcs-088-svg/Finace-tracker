const mongoose = require('mongoose');

// Define the schema for a single financial transaction
const TransactionSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        default: 'default_user'
    },
    type: {
        type: String,
        required: true,
        enum: ['income', 'expense'] 
    },
    category: {
        type: String,
        required: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0.01 
    },
    note: {
        type: String,
        trim: true,
        default: ''
    },
    date: {
        type: Date,
        required: true
    }
}, { 
    timestamps: true 
});

// 🚨 CRITICAL FIX: Ensure the model is created and explicitly exported
module.exports = mongoose.model('Transaction', TransactionSchema);