## Live Portfolio Projects (from markooba.com - EN)

### Abalone Multiplayer — Distributed Processing
A console-based multiplayer remake of the classic Abalone board game, built in C++ with TCP sockets and multithreaded server architecture.
Tags: C++, networking, game, multithreading, sockets

## What is Abalone?

Abalone is a 2-player turn-based strategy game played on a hexagonal board. Each player controls a set of marbles and the objective is to push six of the opponent's marbles off the board.

Players take turns moving 1–3 of their own marbles in a straight line or side-step. If a player has more marbles in line than the opponent — say 2 vs. 1 — they can push the opponent's pieces backward, potentially off the board.

## What I Built

This project recreates Abalone as a console-based networked game. Two players connect to a shared game server over TCP. The server owns the game state and enforces all rules; each client handles input and output.

The architecture is split into three components:

- **Engine** — Core game logic: rules, state transitions, board representation, 

### FMCW Radar Simulation & YOLO Dataset Pipeline
A Python-based simulation toolset built for an engineering thesis to model FMCW radar returns, generate Range-Doppler maps, and automate YOLO-labeled training datasets.
Tags: Python, Radar, Simulation, Computer Vision, YOLO, OpenCV, Signal-Processing

## Context: Engineering Thesis

This project was developed as a core technical component of my Bachelor of Engineering thesis in Data Engineering at Gdańsk University of Technology. 

The primary goal was to bridge the gap between radar signal processing and deep-learning-based computer vision. Training object detection models (such as YOLO) on raw radar outputs is challenging due to the scarcity of annotated radar data. To solve this, I designed and implemented a simulation toolset that generates synthetic, highly accurate, and auto-labeled Range-Doppler (RD) maps.

## How the Pipeline Works

The simulation and dataset generation flow is split into four distinct steps:

1. **Radar Parameter Modeling**: Defines the radar waveform configuration (transmitter frequency sweep, chirp time, puls

### J-Word-Agent — Autonomous EU Job Search Pipeline
An autonomous backend pipeline that scans 50+ job boards, evaluates postings using Gemini with localized EU/UK criteria, and coordinates review via an interactive Telegram bot.
Tags: TypeScript, Playwright, Telegram, Automation, AI, Gemini, Node.js

## What is J-Word-Agent?

Scanning dozens of career portals, filtering out low-quality listings, tailoring CVs, and tracking applications is a full-time job. J-Word-Agent is an autonomous pipeline designed to run 24/7 on a Raspberry Pi or Docker host, automating the entire process. 

It is a heavily extended fork of [career-ops](https://github.com/santifer/career-ops), customized to target the European, UK, and Nordic job markets. The project integrates multi-board web scraping, localized AI-driven candidate-role matching, PDF compilation, and a Telegram-first review interface.

## How It Works

The system operates in a multi-stage loop:

1. **Zero-Token Scanning**: A scheduled scraper queries company career pages and regional job portals (like JustJoin.it, NoFluffJobs, and Remotive) using

### Cylindrical Magnetron Electron Simulator
A high-fidelity Rust and WebAssembly physical simulator modeling electron dynamics in a cylindrical magnetron under space-charge-limited emission and diocotron instability.
Tags: Rust, WebAssembly, Physics, Poisson-Solver, Multigrid, Wasm-pack

## What is the Cylindrical Magnetron Simulator?

This project is a high-fidelity physical simulation of an electron moving through the crossed electric and magnetic fields of a cylindrical magnetron (modeled after the 2D2S direct-heated vacuum diode). 

It was built to reproduce the classic \"magnetron method\" laboratory experiment for measuring the electron's specific charge ($e/m$) and initial thermal velocity ($v_0$) from the Hull cutoff condition. However, instead of stopping at the textbook, idealized single-particle model, this simulator models self-consistent space charge forces and the resulting diocotron instability that naturally shapes real experimental data.

## Physical Accuracy & Validation

To ensure the simulation remains physically accurate rather than a watered-down web 

### Meloman — Layered Enterprise Music Catalog
A scalable three-tier enterprise application built using Jakarta EE and Apache Derby for managing personal music collections and generating playlist statistics.
Tags: Java, Jakarta EE, JPA, EJB, Servlets, Derby, Maven

## What is Meloman?

Meloman is an enterprise application designed to manage and categorize personal music collections. It catalogs tracks, albums, artists, record labels, genres, and styles, while also tracking user playlists and computing usage statistics. 

The project was built to demonstrate enterprise architecture principles: strong boundaries between the representation, business logic, and persistence layers to ensure scalability and ease of maintenance.

## Architecture & Design Patterns

The application follows a classic three-tier enterprise model:

- **Presentation Layer**: Built using Jakarta Servlets and JSP (JavaServer Pages) with JSTL (Jakarta Standard Tag Library) for server-side rendering of the user interface.
- **Business Logic Layer**: Implemented as stateless EJB (Ente

### OrniWatch — Passive Bird Species Detection via CRNN
A deep learning system for passive acoustic monitoring of bird species, utilizing a Convolutional Recurrent Neural Network (CRNN) to detect vocalizations in long-form audio.
Tags: Python, AI, Simulation, Signal-Processing, Computer Vision

## What is OrniWatch?

Automated bird species identification from raw audio is a task with significant value for biodiversity monitoring, ecological surveys, and conservation research. Passive acoustic monitoring generates massive volumes of long-form audio data, making manual inspection impossible. 

OrniWatch is a deep-learning system designed to detect bird vocalizations in long-form recordings, outputting per-frame predictions over time for each of 10 target species.

The core challenge addressed is **extreme label sparsity**—positive label fractions occupy only about 0.005 of the temporal dimension.

## Results & Observations

### Handling Label Sparsity

The extreme sparsity of the time dimension (positive label fraction ≈ 0.005) was tackled by introducing large positive-sample weigh

### Ridder — AI Batch Listing Generator
A full-stack workspace that uses computer vision and multimodal AI to group clothing photos and generate copy-paste ready marketplace listings in bulk.
Tags: TypeScript, Python, AI, Next.js, FastAPI, Docker, Gemini

## What is Ridder?

Listing pre-owned clothes on marketplaces like Vinted is tedious. You take twenty photos across a dozen items, then manually create a separate listing for each one — writing descriptions, tagging brands, estimating sizes, picking prices. Multiply that by a full wardrobe clearout and it becomes a day of repetitive work.

Ridder eliminates that. You drop all your photos into a single batch. It figures out which images belong to the same physical item, groups them, then uses a multimodal AI model to write the full listing for you — brand, size, condition, measurements, SEO tags, localized price — ready to paste.

## How It Works

The pipeline has two stages:

1. **Visual clustering** — Ridder processes a flat folder of unstructured photos and detects which images are diffe
