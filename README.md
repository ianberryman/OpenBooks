# OpenBooks

An open-source small business accounting platform designed to provide powerful accounting functionality in a user friendly format.

The source is licensed under GPLv3 to ensure it remains open to anyone that wants to modify or extend it. 

## Core Functionality
| | | |
|:-----:|:-----:|:-----:|
| Double Entry Accounting | Expense/Revenue Tracking | Invoicing |
| Bank Import/Reconciliation | Reports | Financial Statements |
| Web/Mobile Apps | Dashboards | Open API |

## Architecture
This platform is separated into several distinct layers to ensure it can be exended and deployed in many different environments.

It is conceptually similar to model-view-controller (MVC) in that it is composed of a web API (view) exposing core business logic (controller) backed by a standard data model with various data provider implementations (model). This serves to simplify extensibility and provide a clear guide for future development.

The goal is to offer this platform as a pre-packaged distributable application that can be easily deployed by users without technical skill. No CLI installation or web server required, simply download the application and run it; the only base requirement is the JVM. That being said, users with different needs or existing hardware should be able to deploy a less opinionated version. A cloud offering may also be considered if it is deemed beneficial for end users and can be justified given the costs.

## Tech Stack
The core business logic layer is written in Java 8 using the Spring framework. Spring provides a plethora of useful libraries for server processing, data abstraction and API creation. The web API is documented with RAML which is then implemented via Spring.

The base web UI is written in ReactJS (repo coming soon) to enable powerful, responsive client-side functionality. However, as mentioned in Architecture, the platform is designed to be extended easily. The web API provides all the core functionality in a format that can be implemented by other UI frameworks and languages and mobile applications.

## Contributing
As this project is in its early stages, we are actively looking for contributors. Much work is to be done from design to coding to documentation; all of these areas require special attention and will benefit from your input. Feel free to make suggestions, open issues and submit pull requests to improve the platform. 
