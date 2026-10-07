# Radar BC Maroc

Radar BC Maroc is a monitoring and matching system for Moroccan public **bons de commande**.

It collects published opportunities, structures their content, matches them against a company's business and technical profile, and produces explainable alerts so users can focus on the opportunities that are actually relevant.

## What it does

- Collects and normalizes public BC opportunities
- Uses lexical and semantic matching
- Scores relevance with explainable signals
- Supports company business/technical profiles
- Tracks known vs. new opportunities
- Supports automated notification workflows
- Runs as a cloud service with background workers

## Stack

Python · FastAPI · PostgreSQL · Redis · background workers · embeddings / semantic search · cloud deployment

## Status

Active project / production-oriented prototype.

## Related services

I also build remote web, automation, AI integration, OCR/document-intelligence and data workflows.

**AI Automation & Web Studio:**  
https://capital-agent-api-production.up.railway.app/agency

Built by [Hamza Lebbar](https://github.com/lebbarham-arch).
