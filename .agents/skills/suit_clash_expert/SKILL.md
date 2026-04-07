---
name: suit_clash_expert
description: Specialized knowledge for maintaining and developing the Suit Clash card game.
---

# Suit Clash Expert Skill

This skill provides comprehensive knowledge and instructions for working on the **Suit Clash** project, a real-time multiplayer card game.

## Project Overview
Suit Clash is a web-based multiplayer card game inspired by "Suit" (Rock-Paper-Scissors in Indonesian) but implemented using a standard deck of cards.

- **Stack**: Node.js, Express, Socket.io, Vanilla JS/CSS/HTML.
- **Repository Path**: `c:\laragon\www\suit-clash-updated`
- **Main Entry Point**: `server.js`
- **Frontend**: `public/index.html` (contains all CSS and Client JS)

---

## Core Game Mechanics

### Card Ranks & Suits
- **Suits**: ♠ (Sekop), ♥ (Hati), ♦ (Wajik), ♣ (Keriting).
- **Ranks**:
  - `A`: 14 (Highest)
  - `K`: 13
  - `Q`: 12
  - `J`: 11
  - `10` through `2`: Numeric value.

### Game Flow
1.  **Lobby**: Players join a room (Max 4). The first player is the Host.
2.  **Start**: Only the Host can start. Each player gets 4 cards. One card is placed on the table to set the initial suit.
3.  **Turns**: Players must play a card matching the `currentSuit`.
4.  **Drawing**: If a player cannot match the suit:
    - They draw 1 card from the deck.
    - If the deck is empty, they must take the top card from the `tableHistory`. The turn then shifts back, and the next player becomes the controller (Free Mode).
5.  **Resolving Rounds**: When all active players have played or been skipped, the player who played the highest rank card wins the round.
6.  **Controller & Free Mode**: The winner of the previous round becomes the "Controller." They can play any card to set the new suit (`freeMode`).
7.  **Winning/Losing**: The first player(s) to empty their hand "win" (exit the game). The last player left with cards "loses."

---

## Communication Protocol (Socket.io)

### Client to Server (`socket.emit`)
| Event | Payload | Description |
| :--- | :--- | :--- |
| `joinRoom` | `{ name, room }` | Joins a specific room. |
| `startGame` | - | Host starts the game. |
| `playCard` | `{ index, cardId }` | Play a card from hand. |
| `drawCard` | - | Draw from deck if no valid suit. |
| `takeTableCard`| - | Take from table if deck is empty. |
| `reorderCardHand`| `{ fromIndex, toIndex }` | Manual sorting. |
| `chat` | `message` | Send chat text. |
| `sendEmoji` | `{ emoji, text }` | Send animated emoji/taunt. |
| `getLeaderboard`| - | Request global standings. |
| `restartGame` | - | Host resets the game after Game Over. |

### Server to Client (`socket.on`)
| Event | Payload | Description |
| :--- | :--- | :--- |
| `state` | `GameState` | Full sync of game data (cards, turns, etc). |
| `roundResolved`| `{ winner, winnerName, roundCards }` | Animation trigger for round end. |
| `playerOut` | `{ name }` | When someone empties their hand. |
| `gameOver` | `{ loserName }` | Final result. |
| `deckExhausted`| `{ takerName, ... }` | Alert when someone takes from table. |
| `leaderboardData`| `Array` | Sorted list of player points. |

---

## Technical Design

### Styling (CSS)
Located within `<style>` in `index.html`. Uses a "Casino Felt" aesthetic.
- **Tokens**:
  - `--felt`: Primary green background (`#1b4d35`).
  - `--gold`: Highlight color (`#c9a84c`).
  - `--card-bg`: Creamy card color (`#fdf8f0`).
- **Layout**: Uses absolute positioning for opponent seats (`top`, `left`, `right`) and a central "Board" area.

### State Management
- **Server**: Stores `rooms` Map. Each room has a `GameState` object.
- **Client**: Updates UI reactively based on the `state` event.

---

## Development & Maintenance

### Running Locally
```bash
node server.js
```
The server runs on `http://localhost:1234` by default.

### Key logic locations
- **Card Comparison**: `getRank(v)` in `server.js`.
- **Turn Logic**: `nextTurn()` and `resolveRound()` in `server.js`.
- **Card Rendering**: `renderHand()` and `renderTable()` in `index.html`.
- **Visual Effects**: `showSelfEmoji()`, `playClutchSound()` in `index.html`.

### Adding Features
1. Update `GameState` in `makeGame()` (Server).
2. Implement logic in `server.js` and emit `state`.
3. Update UI in `index.html` to reflect the new state.
