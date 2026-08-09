# Twitter News Feed: Push vs. Pull System Design Benchmark

This repository contains a high-performance benchmarking suite designed to compare the two classic system design approaches for a high-scale News Feed/Timeline delivery system: **The Push Model (Fan-out on Write)** and **The Pull Model (Fan-out on Read)**.

It supports local development using Docker & SQLite, and cloud deployment on Render.com using a managed PostgreSQL database and a managed Redis cache.

---

## 1. System Architecture

The benchmark implements a **Hybrid Model (Celebrity Fan-out)** which splits users into two categories based on follower counts:
*   **Standard Users (Push Model):** When they tweet, their tweet ID is instantly pushed to their followers' pre-computed feed caches (Redis Sorted Sets `ZSET`).
*   **Celebrity Users (Pull Model):** When they tweet, their tweet is only saved in the main database. When a follower refreshes their feed, the system dynamically queries the DB for followed celebrities' tweets, merges them with the pushed feed, and sorts them chronologically.

---

## 2. Project Structure

```text
├── docker-compose.yml     # Orchestrates Node.js and Redis containers
├── Dockerfile             # Builds the Node.js application container
├── package.json           # Defines dependencies and run scripts
├── server.js              # Express API orchestrator & DB schema setup
├── db.js                  # Database adapter (SQLite locally / PostgreSQL in cloud)
├── cache.js               # Shared Redis client connection
├── config.js              # System constants and configuration properties
├── benchmark.js           # Autocannon load-testing script
├── render.yaml            # Render Blueprint Infrastructure as Code
└── routes/
    ├── seed.js            # Seeding endpoint logic (SQL transaction-optimized)
    └── feed.js            # Push and Pull timeline endpoints
```

---

## 3. Local Development (Docker)

To run the benchmark locally on your machine, you must have **Docker Desktop** installed.

### Commands:

1.  **Build and Start the Environment:**
    ```bash
    npm run docker:up
    ```
    This spins up the Node.js API container (exposed on port `3000`) and the Redis container in the background.

2.  **Seed the Database:**
    ```bash
    npm run docker:seed
    ```
    This triggers database seeding (`POST /seed`) to populate the SQLite database with **1,000 users**, follow relationships, and **30,000+ tweets**.

3.  **Execute the Benchmark:**
    ```bash
    npm run docker:benchmark
    ```
    This hammers the `/feed/pull` and `/feed/push` endpoints with **400 concurrent clients** for 30 seconds and prints a comparative ASCII table.

4.  **Tear Down the Environment:**
    ```bash
    npm run docker:down
    ```

---

## 4. Production Cloud Deployment (Render.com)

This project is configured with a **Render Blueprint** (`render.yaml`). To deploy the entire distributed system (PostgreSQL, Redis, and Express API) to Render:

1.  Create a new repository on GitHub and push this code.
2.  Log in to your Render Dashboard, click **New +**, and select **Blueprint**.
3.  Connect your GitHub repository and click **Apply/Approve**.
4.  Render will automatically provision:
    *   A managed PostgreSQL database.
    *   A managed Redis cache.
    *   A Dockerized web service running the Node.js Express API.

---

## 5. Security & Authentication Guard

To prevent public users from resetting the database or overloading your Cloud CPU instances, the endpoints are protected by an **API Key Guard**:

*   **Local Development:** Bypassed automatically. If no `API_KEY` environment variable is defined, all routes remain public.
*   **Production (Render):** Render automatically generates a secure, random `API_KEY` environment variable inside your service.
    
### How to run Cloud Benchmarks:
1.  Go to your Render Web Service dashboard, navigate to the **Environment** tab, and copy your auto-generated `API_KEY`.
2.  Seed your Cloud database:
    ```bash
    TARGET_URL=https://your-app.onrender.com API_KEY=your-render-key npm run seed
    ```
3.  Run the benchmark suite from your Mac (as many times as you like without re-seeding):
    ```bash
    TARGET_URL=https://your-app.onrender.com API_KEY=your-render-key npm run benchmark
    ```
