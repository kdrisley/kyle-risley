'use strict';

/*
 * Pong — 1 player vs. the computer.
 *
 * The file is browser code: the bootstrap at the bottom is guarded by a
 * `typeof document` check so it stays inert when the test runner evaluates
 * this source in Node. The pure functions above it (reflectOffWall,
 * paddleBounce, computeAITarget, checkScore, isGameOver, serveBall) carry the
 * game's physics and are exercised directly by pong.test.js.
 */

// --- Constants ---------------------------------------------------------------

const COURT = { width: 800, height: 500 };
const PADDLE = { width: 14, height: 84, margin: 26 };
const BALL_RADIUS = 9; // half-width of the (square) ball
const WIN_SCORE = 11;
const BALL_SPEED = 6.5; // launch speed
const BALL_SPEED_MAX = 13; // hard cap so rallies stay playable
const BALL_SPEEDUP = 0.4; // added per paddle hit
const AI_SPEED = 5; // CPU paddle px/frame cap — the "balanced" knob
const AI_DEADZONE = 12; // CPU ignores offsets smaller than this (adds slack)
const PADDLE_SPEED = 8; // player keyboard px/frame
const MAX_BOUNCE_ANGLE = (50 * Math.PI) / 180;
const SERVE_FRAMES = 50; // pause between points

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

// --- Pure game logic (unit-tested) ------------------------------------------

// Bounce the ball off the top/bottom walls. Mutates and returns the ball.
function reflectOffWall(ball) {
    if (ball.y - BALL_RADIUS < 0) {
        ball.y = BALL_RADIUS;
        ball.vy = Math.abs(ball.vy);
    } else if (ball.y + BALL_RADIUS > COURT.height) {
        ball.y = COURT.height - BALL_RADIUS;
        ball.vy = -Math.abs(ball.vy);
    }
    return ball;
}

// Given a confirmed paddle hit, compute the rebound velocity. The bounce angle
// depends on where the ball struck the paddle face; speed ticks up to a cap.
// `side` is 'left' (player) or 'right' (cpu) and sets the outgoing x direction.
function paddleBounce(ball, paddle, side) {
    const half = paddle.height / 2;
    const rel = clamp((ball.y - (paddle.y + half)) / half, -1, 1);
    const angle = rel * MAX_BOUNCE_ANGLE;
    const speed = Math.min(BALL_SPEED_MAX, Math.hypot(ball.vx, ball.vy) + BALL_SPEEDUP);
    const dir = side === 'left' ? 1 : -1;
    ball.vx = dir * speed * Math.cos(angle);
    ball.vy = speed * Math.sin(angle);
    return ball;
}

// Where the CPU paddle should move this frame. It chases the ball only while
// the ball travels toward it; otherwise it drifts back toward center. The step
// is always capped by AI_SPEED, which keeps the opponent beatable.
function computeAITarget(ball, paddle) {
    const center = paddle.y + paddle.height / 2;
    let target = paddle.y;
    if (ball.vx > 0) {
        const diff = ball.y - center;
        if (Math.abs(diff) > AI_DEADZONE) {
            target = paddle.y + clamp(diff, -AI_SPEED, AI_SPEED);
        }
    } else {
        const diff = COURT.height / 2 - center;
        target = paddle.y + clamp(diff, -AI_SPEED * 0.5, AI_SPEED * 0.5);
    }
    return clamp(target, 0, COURT.height - paddle.height);
}

// Returns who scored ('player' | 'cpu') once the ball clears a side, else null.
function checkScore(ball) {
    if (ball.x + BALL_RADIUS < 0) return 'cpu';
    if (ball.x - BALL_RADIUS > COURT.width) return 'player';
    return null;
}

function isGameOver(scores) {
    return scores.player >= WIN_SCORE || scores.cpu >= WIN_SCORE;
}

// A fresh ball launched from center. `direction` is -1 (toward player) or +1.
function serveBall(direction) {
    const angle = (Math.random() * 2 - 1) * ((30 * Math.PI) / 180);
    return {
        x: COURT.width / 2,
        y: COURT.height / 2,
        vx: direction * BALL_SPEED * Math.cos(angle),
        vy: BALL_SPEED * Math.sin(angle)
    };
}

// --- Browser bootstrap -------------------------------------------------------

if (typeof document !== 'undefined') {
    const canvas = document.getElementById('court');
    const ctx = canvas.getContext('2d');

    const game = {
        state: 'idle', // idle | serving | playing | over
        scores: { player: 0, cpu: 0 },
        ball: { x: COURT.width / 2, y: COURT.height / 2, vx: 0, vy: 0 },
        player: makePaddle(PADDLE.margin),
        cpu: makePaddle(COURT.width - PADDLE.margin - PADDLE.width),
        serveTimer: 0,
        serveDir: 1,
        winner: null
    };
    const keys = { ArrowUp: false, ArrowDown: false };

    function makePaddle(x) {
        return {
            x: x,
            y: (COURT.height - PADDLE.height) / 2,
            width: PADDLE.width,
            height: PADDLE.height
        };
    }

    function startGame() {
        game.scores.player = 0;
        game.scores.cpu = 0;
        game.player.y = (COURT.height - PADDLE.height) / 2;
        game.cpu.y = (COURT.height - PADDLE.height) / 2;
        game.winner = null;
        beginServe(Math.random() < 0.5 ? -1 : 1);
    }

    function beginServe(direction) {
        game.serveDir = direction;
        game.serveTimer = SERVE_FRAMES;
        game.ball = { x: COURT.width / 2, y: COURT.height / 2, vx: 0, vy: 0 };
        game.state = 'serving';
    }

    function movePlayerByKeys() {
        if (keys.ArrowUp) game.player.y -= PADDLE_SPEED;
        if (keys.ArrowDown) game.player.y += PADDLE_SPEED;
        game.player.y = clamp(game.player.y, 0, COURT.height - PADDLE.height);
    }

    function update() {
        if (game.state === 'serving') {
            movePlayerByKeys();
            game.cpu.y = computeAITarget(game.ball, game.cpu);
            game.serveTimer -= 1;
            if (game.serveTimer <= 0) {
                game.ball = serveBall(game.serveDir);
                game.state = 'playing';
            }
            return;
        }
        if (game.state !== 'playing') return;

        movePlayerByKeys();
        game.cpu.y = computeAITarget(game.ball, game.cpu);

        const b = game.ball;
        b.x += b.vx;
        b.y += b.vy;
        reflectOffWall(b);

        const p = game.player;
        const c = game.cpu;
        if (
            b.vx < 0 &&
            b.x - BALL_RADIUS <= p.x + p.width &&
            b.x > p.x &&
            b.y + BALL_RADIUS >= p.y &&
            b.y - BALL_RADIUS <= p.y + p.height
        ) {
            paddleBounce(b, p, 'left');
            b.x = p.x + p.width + BALL_RADIUS;
        } else if (
            b.vx > 0 &&
            b.x + BALL_RADIUS >= c.x &&
            b.x < c.x + c.width &&
            b.y + BALL_RADIUS >= c.y &&
            b.y - BALL_RADIUS <= c.y + c.height
        ) {
            paddleBounce(b, c, 'right');
            b.x = c.x - BALL_RADIUS;
        }

        const scorer = checkScore(b);
        if (scorer) {
            game.scores[scorer] += 1;
            if (isGameOver(game.scores)) {
                game.winner = scorer;
                game.state = 'over';
            } else {
                // Serve toward whoever just conceded the point.
                beginServe(scorer === 'cpu' ? -1 : 1);
            }
        }
    }

    function drawNet() {
        ctx.fillStyle = '#fff';
        for (let y = 6; y < COURT.height; y += 28) {
            ctx.fillRect(COURT.width / 2 - 2, y, 4, 16);
        }
    }

    function drawCenteredText(text, y, size) {
        ctx.fillStyle = '#fff';
        ctx.font = size + 'px "Courier New", Courier, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(text, COURT.width / 2, y);
    }

    function render() {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, COURT.width, COURT.height);
        drawNet();

        ctx.fillStyle = '#fff';
        ctx.font = '64px "Courier New", Courier, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(game.scores.player), COURT.width / 2 - 70, 78);
        ctx.fillText(String(game.scores.cpu), COURT.width / 2 + 70, 78);

        ctx.fillStyle = '#fff';
        ctx.fillRect(game.player.x, game.player.y, game.player.width, game.player.height);
        ctx.fillRect(game.cpu.x, game.cpu.y, game.cpu.width, game.cpu.height);

        if (game.state !== 'idle') {
            ctx.fillRect(
                game.ball.x - BALL_RADIUS,
                game.ball.y - BALL_RADIUS,
                BALL_RADIUS * 2,
                BALL_RADIUS * 2
            );
        }

        if (game.state === 'idle') {
            drawCenteredText('CLICK OR PRESS SPACE TO START', COURT.height / 2 + 8, 24);
        } else if (game.state === 'over') {
            const msg = game.winner === 'player' ? 'YOU WIN' : 'CPU WINS';
            drawCenteredText(msg, COURT.height / 2 - 14, 48);
            drawCenteredText('CLICK OR PRESS SPACE TO PLAY AGAIN', COURT.height / 2 + 34, 20);
        }
    }

    function loop() {
        update();
        render();
        requestAnimationFrame(loop);
    }

    canvas.addEventListener('pointermove', function (e) {
        const rect = canvas.getBoundingClientRect();
        const y = ((e.clientY - rect.top) / rect.height) * COURT.height;
        game.player.y = clamp(y - PADDLE.height / 2, 0, COURT.height - PADDLE.height);
    });

    canvas.addEventListener('pointerdown', function () {
        if (game.state === 'idle' || game.state === 'over') startGame();
    });

    window.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            keys[e.key] = true;
            e.preventDefault();
        } else if (e.key === ' ' || e.code === 'Space') {
            if (game.state === 'idle' || game.state === 'over') startGame();
            e.preventDefault();
        }
    });

    window.addEventListener('keyup', function (e) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') keys[e.key] = false;
    });

    loop();
}
