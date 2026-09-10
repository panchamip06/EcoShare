const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const User = require('./models/User');
const Trip = require('./models/Trip');
const Expense = require('./models/Expense');
const Settlement = require('./models/Settlement');
const Donation = require('./models/Donation');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const PORT = process.env.PORT || 3000;

// Connect to MongoDB
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');
        // Drop legacy googleId unique index that causes duplicate key errors for new users
        try {
            await mongoose.connection.collection('users').dropIndex('googleId_1');
            console.log('Legacy googleId_1 index dropped successfully.');
        } catch (idxErr) {
            // Index might not exist, which is fine
        }
    } catch (err) {
        console.error('MongoDB Connection Error:', err);
        // Do not exit, allow retry or user to fix env
    }
};
connectDB();

// --- Auth Routes ---
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: "User already exists" });

        const user = await User.create({
            id: uuidv4(),
            name,
            email,
            password
        });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email, password });
        if (!user) return res.status(401).json({ error: "Invalid credentials" });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/google', async (req, res) => {
    try {
        const { name, email, photoUrl } = req.body;
        if (!email) return res.status(400).json({ error: "Email required" });

        let user = await User.findOne({ email });

        if (!user) {
            user = await User.create({
                id: uuidv4(),
                name,
                email,
                password: null,
                photoUrl,
                ecoPoints: 10,
                donatedPoints: 0
            });
        } else {
            user.name = name;
            user.photoUrl = photoUrl;
            await user.save();
        }
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upload Proof
app.post('/api/upload', upload.single('proof'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.get('host');
    res.json({ url: `${protocol}://${host}/uploads/${req.file.filename}` });
});

// Get single user by ID
app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await User.findOne({ id: req.params.id });
        if (user) {
            const { password, ...userWithoutPassword } = user.toObject();
            res.json(userWithoutPassword);
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Trip Routes ---
app.post('/api/trips', async (req, res) => {
    try {
        const { name, userId, destination } = req.body;
        const trip = await Trip.create({
            id: uuidv4(),
            name,
            destination,
            creatorId: userId,
            members: [userId],
            shareCode: uuidv4().slice(0, 8),
            expenses: [],
            date: new Date().toISOString()
        });

        // Award 5 points
        await User.findOneAndUpdate({ id: userId }, { $inc: { ecoPoints: 5 } });

        res.json(trip);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get trips for a specific user
app.get('/api/trips/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        // Find trips where members contains userId OR members.id contains userId (legacy support not strictly needed but good to have)
        // Since we schema defined members as [String], we strictly query strings.
        // Also check not deletedForUsers.

        const trips = await Trip.find({
            members: userId,
            deletedForUsers: { $ne: userId }
        });
        res.json(trips);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/trips/:id', async (req, res) => {
    try {
        const trip = await Trip.findOne({ id: req.params.id });
        if (trip) {
            // Hydrate members
            // We need to fetch user details for each member ID
            const memberIds = trip.members;
            const users = await User.find({ id: { $in: memberIds } });

            // Map users to a lookup map
            const userMap = {};
            users.forEach(u => userMap[u.id] = u);

            const hydratedMembers = memberIds.map(mId => {
                const user = userMap[mId];
                return user ? { id: user.id, name: user.name, photoUrl: user.photoUrl } : { id: mId, name: 'Unknown' };
            });

            const tripObj = trip.toObject();
            tripObj.members = hydratedMembers;
            res.json(tripObj);
        } else {
            res.status(404).json({ error: "Trip not found" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update a trip
app.patch('/api/trips/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        const trip = await Trip.findOneAndUpdate({ id }, { name }, { new: true });
        if (!trip) return res.status(404).json({ error: 'Trip not found' });
        res.json(trip);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete/Leave a trip for a specific user
app.delete('/api/trips/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.query;

        console.log(`User ${userId} attempting to delete trip from their view: ${id}`);

        const trip = await Trip.findOne({ id });
        if (!trip) return res.status(404).json({ error: 'Trip not found' });

        // Initialize deletedForUsers if it doesn't exist
        if (!trip.deletedForUsers) trip.deletedForUsers = [];

        if (!trip.deletedForUsers.includes(userId)) {
            trip.deletedForUsers.push(userId);
        }

        // Check if everyone has deleted it
        const allMembersDeleted = trip.members.every(m => trip.deletedForUsers.includes(m));

        if (allMembersDeleted) {
            await Trip.deleteOne({ id });
            console.log(`Trip ${id} deleted entirely as all members removed it.`);
        } else {
            await trip.save();
            console.log(`Trip ${id} hidden for user ${userId}.`);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Leave a trip (officially remove from members)
app.post('/api/trips/:id/leave', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;

        console.log(`User ${userId} attempting to leave trip: ${id}`);

        const trip = await Trip.findOne({ id });
        if (!trip) return res.status(404).json({ error: "Trip not found" });

        trip.members = trip.members.filter(m => m !== userId);

        if (trip.members.length === 0) {
            await Trip.deleteOne({ id });
            console.log(`Trip ${id} deleted as last member left.`);
        } else {
            await trip.save();
            console.log(`User ${userId} left trip ${id}.`);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/trips/join', async (req, res) => {
    try {
        const { userId, shareCode } = req.body;
        const trip = await Trip.findOne({ shareCode });

        if (!trip) return res.status(404).json({ error: "Invalid code" });

        // Check if already member
        const isMember = trip.members.includes(userId);

        // If user previously deleted this trip from their view, restore it
        if (trip.deletedForUsers && trip.deletedForUsers.includes(userId)) {
            trip.deletedForUsers = trip.deletedForUsers.filter(id => id !== userId);
        }

        if (!isMember) {
            trip.members.push(userId);
            await User.findOneAndUpdate({ id: userId }, { $inc: { ecoPoints: 2 } });
        }
        await trip.save();

        res.json(trip);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Leaderboard & Impact ---
app.get('/api/leaderboard', async (req, res) => {
    try {
        const leaders = await User.find({})
            .sort({ ecoPoints: -1 })
            .select('id name photoUrl ecoPoints donatedPoints');
        res.json(leaders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/donate', async (req, res) => {
    try {
        const { userId, amount, cause } = req.body;
        const user = await User.findOne({ id: userId });

        if (!user || user.ecoPoints < amount) {
            return res.status(400).json({ error: "Insufficient points" });
        }

        user.ecoPoints -= amount;
        user.donatedPoints += amount;
        await user.save();

        await Donation.create({
            id: uuidv4(),
            userId,
            amount,
            cause,
            date: new Date().toISOString()
        });

        res.json({ success: true, newBalance: user.ecoPoints, newDonated: user.donatedPoints });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Expense Routes ---
app.post('/api/expenses', async (req, res) => {
    try {
        const { tripId, description, amount, payerId, splitDetails, isEcoFriendly, proofImageUrl, verification } = req.body;

        const expense = await Expense.create({
            id: uuidv4(),
            tripId,
            description,
            amount: parseFloat(amount),
            payerId,
            splitWith: req.body.splitWith,
            date: new Date().toISOString(),
            isEcoFriendly: isEcoFriendly || false,
            proofImageUrl: proofImageUrl || null,
            verification: verification || null
        });

        // Eco Points Logic
        if (isEcoFriendly) {
            await User.findOneAndUpdate({ id: payerId }, { $inc: { ecoPoints: 50 } });
        }

        res.json(expense);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/expenses/:tripId', async (req, res) => {
    try {
        const expenses = await Expense.find({ tripId: req.params.tripId });
        res.json(expenses);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/expenses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const expense = await Expense.findOne({ id });

        if (!expense) return res.status(404).json({ error: "Expense not found" });

        if (expense.isEcoFriendly) {
            // Deduct points, but don't go below 0
            const user = await User.findOne({ id: expense.payerId });
            if (user) {
                user.ecoPoints = Math.max(0, user.ecoPoints - 50);
                await user.save();
            }
        }

        await Expense.deleteOne({ id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Settlement/Split Logic ---
app.get('/api/trips/:id/summary', async (req, res) => {
    try {
        const tripId = req.params.id;
        const trip = await Trip.findOne({ id: tripId });
        if (!trip) return res.status(404).json({ error: 'Trip not found' });

        const expenses = await Expense.find({ tripId });
        const settlements = await Settlement.find({ tripId });

        const balances = {};
        trip.members.forEach(m => {
            balances[m] = 0;
        });

        expenses.forEach(exp => {
            const paidBy = exp.payerId;
            const amount = exp.amount;
            let splitIds = exp.splitWith && exp.splitWith.length > 0
                ? exp.splitWith
                : trip.members;

            if (splitIds.length > 0) {
                const splitAmount = amount / splitIds.length;
                if (balances[paidBy] === undefined) balances[paidBy] = 0;
                balances[paidBy] += amount;

                splitIds.forEach(uid => {
                    if (balances[uid] === undefined) balances[uid] = 0;
                    balances[uid] -= splitAmount;
                });
            }
        });

        settlements.forEach(settlement => {
            const { fromUserId, toUserId, amount } = settlement;
            if (balances[fromUserId] !== undefined) balances[fromUserId] += amount;
            if (balances[toUserId] !== undefined) balances[toUserId] -= amount;
        });

        const debts = [];
        const debtors = [];
        const creditors = [];

        Object.keys(balances).forEach(uid => {
            const val = balances[uid];
            if (val < -0.01) debtors.push({ id: uid, amount: -val });
            if (val > 0.01) creditors.push({ id: uid, amount: val });
        });

        let d = 0;
        let c = 0;

        while (d < debtors.length && c < creditors.length) {
            const debtor = debtors[d];
            const creditor = creditors[c];
            const amount = Math.min(debtor.amount, creditor.amount);

            debts.push({
                from: debtor.id,
                to: creditor.id,
                amount: parseFloat(amount.toFixed(2))
            });

            debtor.amount -= amount;
            creditor.amount -= amount;

            if (debtor.amount < 0.01) d++;
            if (creditor.amount < 0.01) c++;
        }

        res.json({ balances, debts, settlements });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Settlement Routes ---
app.post('/api/settlements', async (req, res) => {
    try {
        const { tripId, fromUserId, toUserId, amount } = req.body;
        if (!tripId || !fromUserId || !toUserId || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const settlement = await Settlement.create({
            id: uuidv4(),
            tripId,
            fromUserId,
            toUserId,
            amount: parseFloat(amount),
            date: new Date().toISOString()
        });

        res.json(settlement);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/settlements/:tripId', async (req, res) => {
    try {
        const settlements = await Settlement.find({ tripId: req.params.tripId });
        res.json(settlements);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Activity Feed ---
app.get('/api/user/:userId/activity', async (req, res) => {
    try {
        const { userId } = req.params;

        // Trips Created
        const userTrips = await Trip.find({
            creatorId: userId,
            deletedForUsers: { $ne: userId }
        }).lean();
        const tripsCreated = userTrips.map(t => ({
            type: 'TRIP_CREATED',
            title: `Started trip to ${t.destination || 'a new destination'}`,
            points: 5,
            date: t.date
        }));

        // Trips Joined (where created by someone else)
        const joinedTrips = await Trip.find({
            creatorId: { $ne: userId },
            members: userId,
            deletedForUsers: { $ne: userId }
        }).lean();
        const tripsJoined = joinedTrips.map(t => ({
            type: 'TRIP_JOINED',
            title: `Joined trip to ${t.destination || 'a new destination'}`,
            points: 2,
            date: t.date
        }));

        // Eco Expenses
        const ecoExpenses = await Expense.find({
            payerId: userId,
            isEcoFriendly: true
        }).lean();
        const expenseActivities = ecoExpenses.map(e => ({
            type: 'ECO_EXPENSE',
            title: `Eco-friendly: ${e.description}`,
            points: 50,
            date: e.date
        }));

        // Donations
        const userDonations = await Donation.find({ userId }).lean();
        const donationActivities = userDonations.map(d => ({
            type: 'DONATION',
            title: `Donated to ${d.cause}`,
            points: -d.amount,
            date: d.date
        }));

        const allActivity = [...tripsCreated, ...tripsJoined, ...expenseActivities, ...donationActivities]
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 10);

        res.json(allActivity);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
