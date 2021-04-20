[![Open Source Love](https://badges.frapsoft.com/os/v1/open-source.svg?v=102)](https://github.com/ellerbrock/open-source-badge/)
[![Open Source Helpers](https://www.codetriage.com/berryman17/openbooks/badges/users.svg)](https://www.codetriage.com/berryman17/openbooks)

[![GitHub version](https://badge.fury.io/gh/berryman17%2FOpenBooks.svg)](https://badge.fury.io/gh/berryman17%2FOpenBooks)
[![Coverage Status](https://coveralls.io/repos/github/berryman17/OpenBooks/badge.svg?branch=develop)](https://coveralls.io/github/berryman17/OpenBooks?branch=develop)
[![codebeat badge](https://codebeat.co/badges/e0e05c0e-5d64-48e9-bc0f-c9c71e48b3bc)](https://codebeat.co/projects/github-com-berryman17-openbooks-master)


# OpenBooks API

An open-source small business accounting platform designed to provide powerful accounting functionality in a user friendly format.

[![OpenBooks UI Concept](https://i.ibb.co/LJSfsn1/Open-Books-concept-01-25-2020.png "OpenBooks UI Concept")](https://github.com/berryman17/OpenBooksUI)

The source is licensed under GPLv3 to ensure it remains open to anyone that wants to modify or extend it. 

Get started quickly by cloning this repository and creating a `.env` file in the root directory containing the following (replace your_db_username and your_db_password):
```
# Server PostgreSQL
PGUSER={your_db_username}
PGHOST=db
PGPASSWORD={your_db_password}
PGDATABASE=openbooks
PGPORT=5432

# PostgreSQL docker init
POSTGRES_DB=postgres
POSTGRES_USER={your_db_username}
POSTGRES_PASSWORD={your_db_password}
```

Then run:
```
npm install

docker-compose up
```

By default the API is available on port `8080` and PostgreSQL is available on port `8001`. You can adjust the exposed ports if needed by modifying `docker-compose.yml`.

## Core Functionality
| | | |
|:-----:|:-----:|:-----:|
| Double Entry Accounting | Expense/Revenue Tracking | Invoicing |
| Bank Import/Reconciliation | Reports | Financial Statements |
| Web/Mobile Apps | Dashboards | Open API |
| Customers/Vendors | Mileage Tracking ||

## Architecture
This platform is separated into several distinct layers forming an n-tier architecture to ensure it can be extended and deployed in many different environments.

It is composed of a API exposing core business logic (this repo) backed by a standard data model with various data provider implementations. This serves to simplify extensibility and provide a clear guide for future development. There is also a pre-built front-end over at [OpenBooksUI](https://github.com/berryman17/OpenBooksUI) but custom implementations are encouraged.

The goal is to offer this platform as a pre-packaged distributable application that can be easily deployed by users without technical skill. No CLI installation or web server required, simply download the application and run it; the only base requirement is the JVM. That being said, users with different needs or existing hardware should be able to deploy a less opinionated version. A cloud offering may also be considered if it is deemed beneficial for end users and can be justified given the costs.

## Tech Stack
The core business logic layer is written in NodeJS using Apollo for GraphQL support. 

The base web UI is written in ReactJS ([OpenBooksUI](https://github.com/berryman17/OpenBooksUI)) to enable powerful, responsive client-side functionality. However, as mentioned in Architecture, the platform is designed to be extended easily. The web API provides all the core functionality in a format that can be implemented by other UI frameworks and languages and mobile applications.

## Contributing
As this project is in its early stages, we are in need of contributors. Much work is to be done from design to coding to documentation; all of these areas require special attention and will benefit from your input. Feel free to make suggestions, open issues and submit pull requests to improve the platform. 

Git Flow is used to keep track of branches and the various stages of development
that they represent.

| Branch Pattern | Purpose |
|-----|-----|
|master|Contains release history|
|release|Contains a specific release version (e.g. `release/1.0.0`)|
|develop|Contains "next release" actively in development|
|feature|Contains work for a specific feature (e.g. `feature/do-something`)|
|bugfix|Contain fixes for a bug (e.g. `bugfix/uh-oh`)|

Run `git flow init` to enable Git Flow when you clone this repository and accept all of the default values for the
branch names. All commits should be done via a branch and submitted in a pull request.

The standard flow from feature to release should look like:

    feature -> develop -> release -> master

where each arrow represents a pull request and merge.
