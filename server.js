// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const suits = ['♠', '♥', '♦', '♣'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

let users = {}; // Bankrolls & persistence { username: balance }
let rooms = {}; // All active tables

function getDeck() {
    let deck = [];
    suits.forEach(suit => values.forEach((value, idx) => 
        deck.push({ suit, value, valNum: idx + 2, color: (suit === '♥' || suit === '♦') ? 'text-red-500' : 'text-black' })
    ));
    return deck.sort(() => Math.random() - 0.5);
}

// Minimal 7-Card Poker Evaluator (Score based for quick comparing)
function evaluateHand(hand, board) {
    let cards = [...hand, ...board].sort((a,b) => b.valNum - a.valNum);
    let counts = {}, flushSuit = null, suitCounts = { '♠':0, '♥':0, '♦':0, '♣':0 };
    cards.forEach(c => { counts[c.valNum] = (counts[c.valNum]||0)+1; suitCounts[c.suit]++; });
    for (let s in suitCounts) if(suitCounts[s] >= 5) flushSuit = s;
    let freqs = Object.entries(counts).sort((a,b) => b[1] - a[1] || b[0] - a[0]);
    
    // Simplification for brevity: ranks hand combinations to a number score
    let score = 0;
    if(flushSuit) score += 500; // Flush (Simplified rank hierarchy)
    if(freqs[0][1] === 4) score += 700 + parseInt(freqs[0][0]); // Four of kind
    else if(freqs[0][1] === 3 && freqs[1] && freqs[1][1] >= 2) score += 600 + parseInt(freqs[0][0]); // Full house
    else if(freqs[0][1] === 3) score += 300 + parseInt(freqs[0][0]); // Three of kind
    else if(freqs[0][1] === 2 && freqs[1] && freqs[1][1] === 2) score += 200 + parseInt(freqs[0][0]); // Two pair
    else if(freqs[0][1] === 2) score += 100 + parseInt(freqs[0][0]); // Pair
    else score += parseInt(freqs[0][0]); // High card
    return score;
}

function broadcastLobby() {
    let activeRooms = Object.values(rooms).map(r => ({ id: r.id, game: r.game, players: r.players.length }));
    io.emit('lobby_update', activeRooms);
}

// Main Casino Connection Loop
io.on('connection', (socket) => {
    socket.on('login', (username) => {
        socket.username = username;
        if (!users[username]) users[username] = 1000;
        socket.emit('update_balance', users[username]);
        broadcastLobby();
    });

    socket.on('request_welfare', () => {
        if (users[socket.username] <= 0) {
            users[socket.username] = 100;
            socket.emit('update_balance', users[socket.username]);
            socket.emit('chat_msg', { sys: true, msg: "Bailout granted! +100 chips." });
        }
    });

    // --- SLOTS MINI GAME ---
    socket.on('play_slots', (bet) => {
        if (users[socket.username] < bet) return socket.emit('chat_msg', { sys: true, msg: "Not enough chips!" });
        users[socket.username] -= bet;
        
        const symbols = ['🍒', '🍋', '💎', '🔔', '7️⃣'];
        let result = [symbols[Math.floor(Math.random()*5)], symbols[Math.floor(Math.random()*5)], symbols[Math.floor(Math.random()*5)]];
        
        let win = 0;
        if(result[0] === result[1] && result[1] === result[2]) win = bet * 10;
        else if (result[0] === result[1] || result[1] === result[2]) win = bet * 2;
        
        users[socket.username] += win;
        socket.emit('slots_result', { result, win });
        socket.emit('update_balance', users[socket.username]);
    });

    // --- ROOM MANAGEMENT ---
    socket.on('create_room', ({ roomId, game }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { id: roomId, game: game, players: [], deck: getDeck(), center: [], state: 'waiting', turnIdx: 0, pot: 0, highestBet: 0 };
        }
        broadcastLobby();
    });

    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        let r = rooms[roomId];
        socket.roomId = roomId;
        r.players.push({ id: socket.id, user: socket.username, hand: [], bet: 0, folded: false, allIn: false, invested: 0 });
        io.to(roomId).emit(`update_${r.game}`, r);
        broadcastLobby();
    });

    socket.on('leave_room', () => {
        let r = rooms[socket.roomId];
        if(!r) return;
        r.players = r.players.filter(p => p.id !== socket.id);
        socket.leave(socket.roomId);
        if(r.players.length === 0) delete rooms[socket.roomId];
        else io.to(socket.roomId).emit(`update_${r.game}`, r);
        socket.roomId = null;
        broadcastLobby();
    });

    // --- POKER ENGINE ---
    function progressPokerRound(r) {
        // Find non-folded
        let active = r.players.filter(p => !p.folded);
        if(active.length === 1) return winPoker(r, active[0]); // Everyone folded
        
        r.highestBet = 0;
        r.players.forEach(p => p.bet = 0); // reset street bets

        if(r.state === 'preflop') { r.state = 'flop'; r.center = [r.deck.pop(), r.deck.pop(), r.deck.pop()]; }
        else if(r.state === 'flop') { r.state = 'turn'; r.center.push(r.deck.pop()); }
        else if(r.state === 'turn') { r.state = 'river'; r.center.push(r.deck.pop()); }
        else if(r.state === 'river') {
            // Showdown! Score hands
            let winners = active.map(p => ({ p, score: evaluateHand(p.hand, r.center) })).sort((a,b) => b.score - a.score);
            let bestPlayer = winners[0].p; 
            winPoker(r, bestPlayer); // Distribute Pot (Simplistic full payout handling All In basics inherently if handled via caps later, but for speed giving to winner)
            return;
        }
        
        r.turnIdx = 0; // reset turn
        
        // Let players see the cards dealt for a few seconds before betting starts
        io.to(r.id).emit('chat_msg', {sys: true, msg: `Dealing ${r.state.toUpperCase()}...`});
        io.to(r.id).emit('update_poker', r);
    }

    function winPoker(r, winnerData) {
        r.state = 'showdown';
        io.to(r.id).emit('update_poker', r);
        io.to(r.id).emit('chat_msg', {sys: true, msg: `${winnerData.user} wins pot of $${r.pot}!`});
        users[winnerData.user] += r.pot;
        
        // Find players bottoming out to kick
        r.players.forEach(p => { if (users[p.user] <= 0 && p.id) io.to(p.id).emit('boot_lobby'); });
        
        // Wait 4 seconds to view winner, then reset
        setTimeout(() => {
            if(!rooms[r.id]) return;
            r.players.forEach(p => { p.hand = []; p.bet = 0; p.folded = false; p.allIn = false; p.invested = 0; });
            r.state = 'waiting';
            r.center = []; r.pot = 0; r.highestBet = 0; r.deck = getDeck();
            io.to(r.id).emit('update_poker', r);
            r.players.forEach(p => {
                 const playerSocket = io.sockets.sockets.get(p.id);
                 if(playerSocket) playerSocket.emit('update_balance', users[p.user]);
            });
        }, 4000);
    }

    socket.on('start_poker', () => {
        let r = rooms[socket.roomId];
        if(r.players.length < 2) return;
        r.state = 'preflop'; r.deck = getDeck(); r.pot = 0; r.center = [];
        r.players.forEach(p => {
            p.folded = false; p.invested = 0; p.bet = 0; p.allIn = (users[p.user] <= 0);
            if(!p.allIn) p.hand = [r.deck.pop(), r.deck.pop()];
        });
        r.turnIdx = 0; // Simplified no-blind start
        io.to(r.id).emit('chat_msg', {sys: true, msg: "Hands dealt. Pre-flop."});
        io.to(r.id).emit('update_poker', r);
    });

    socket.on('poker_action', (actionInfo) => {
        let r = rooms[socket.roomId];
        let p = r.players[r.turnIdx];
        if(!p || p.id !== socket.id) return; // Prevent out of turn cheating

        if(actionInfo.type === 'fold') {
            p.folded = true;
        } else if (actionInfo.type === 'check_call') {
            let toCall = r.highestBet - p.bet;
            if(users[p.user] <= toCall) { // All in condition
                toCall = users[p.user];
                p.allIn = true;
            }
            p.bet += toCall; p.invested += toCall; r.pot += toCall;
            users[p.user] -= toCall;
        } else if (actionInfo.type === 'raise') {
            let totalAmount = actionInfo.amount;
            if (users[p.user] <= totalAmount) {
                 totalAmount = users[p.user]; p.allIn = true; // Raise goes All-in
            }
            p.bet += totalAmount; p.invested += totalAmount; r.pot += totalAmount;
            r.highestBet = p.bet;
            users[p.user] -= totalAmount;
        }

        socket.emit('update_balance', users[socket.username]); // update local wallet

        // Cycle to next non-folded/non-allin player
        let endRound = false;
        let checks = 0;
        do {
            r.turnIdx = (r.turnIdx + 1) % r.players.length;
            checks++;
            if(checks > r.players.length) { endRound = true; break; } // Everyone evaluated
        } while (r.players[r.turnIdx].folded || r.players[r.turnIdx].allIn);

        // Check if betting round is over (everyone called highestBet or folded)
        let uncalled = r.players.filter(pl => !pl.folded && !pl.allIn && pl.bet < r.highestBet);
        if(endRound || (checks >= r.players.length && uncalled.length === 0)) {
            setTimeout(() => progressPokerRound(r), 1000); // 1 sec pause before board burns next card
        }

        io.to(r.id).emit('update_poker', r);
    });

    // --- SLAPJACK ENGINE (Speed MultiPlayer Reaction Game) ---
    socket.on('start_slapjack', () => {
        let r = rooms[socket.roomId];
        r.deck = getDeck(); r.center = []; r.state = 'playing'; r.turnIdx = 0;
        let chunkSize = Math.floor(r.deck.length / r.players.length);
        r.players.forEach(p => { p.hand = r.deck.splice(0, chunkSize); });
        io.to(r.id).emit('update_slapjack', r);
    });

    socket.on('slapjack_play_card', () => {
        let r = rooms[socket.roomId];
        if (r.state !== 'playing' || r.players[r.turnIdx].id !== socket.id) return;
        let p = r.players[r.turnIdx];
        if (p.hand.length > 0) {
            r.center.push(p.hand.shift());
            io.to(r.id).emit('card_played_sound');
        }
        r.turnIdx = (r.turnIdx + 1) % r.players.length;
        io.to(r.id).emit('update_slapjack', r);
    });

    socket.on('slapjack_slap', () => {
        let r = rooms[socket.roomId];
        if (r.state !== 'playing' || r.center.length === 0) return;
        
        let p = r.players.find(x => x.id === socket.id);
        let topCard = r.center[r.center.length - 1];
        let sndTop = r.center.length >= 2 ? r.center[r.center.length - 2] : null;
        let thrdTop = r.center.length >= 3 ? r.center[r.center.length - 3] : null;

        // Validity Checks: Jack, Doubles, or Sandwich
        let valid = topCard.value === 'J' || 
                    (sndTop && topCard.value === sndTop.value) || 
                    (thrdTop && topCard.value === thrdTop.value);
        
        if(valid) {
            p.hand.push(...r.center); // take the pile
            r.center = [];
            io.to(r.id).emit('chat_msg', { sys: true, msg: `${p.user} correctly slapped!` });
        } else {
            // Penalty
            if(p.hand.length > 0) r.center.unshift(p.hand.shift()); // put one of their cards at bottom
            io.to(r.id).emit('chat_msg', { sys: true, msg: `${p.user} BAD SLAP! Penalized 1 card.` });
        }
        
        // Win condition
        if(p.hand.length >= 52) {
            r.state = 'waiting';
            io.to(r.id).emit('chat_msg', { sys: true, msg: `🏆 ${p.user} WINS SLAPJACK! +250 chips!` });
            users[p.user] += 250;
            io.sockets.sockets.get(p.id).emit('update_balance', users[p.user]);
        }
        
        io.to(r.id).emit('update_slapjack', r);
    });

    socket.on('disconnect', () => {
        if(socket.roomId && rooms[socket.roomId]) {
            rooms[socket.roomId].players = rooms[socket.roomId].players.filter(p => p.id !== socket.id);
            if(rooms[socket.roomId].players.length === 0) delete rooms[socket.roomId];
            else io.to(socket.roomId).emit(`update_${rooms[socket.roomId].game}`, rooms[socket.roomId]);
        }
        broadcastLobby();
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Casino Server running on ${PORT}`));

