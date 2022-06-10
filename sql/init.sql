
DROP DATABASE IF EXISTS openbooks;
CREATE DATABASE openbooks;

use openbooks;

CREATE USER IF NOT EXISTS openbooksapi
identified WITH mysql_native_password BY 'openbooks';

GRANT ALL PRIVILEGES ON openbooks.* to 'openbooksapi'@'%';

create table if not exists account_type (
    account_type varchar(20) not null,

    constraint pk_account_type primary key (account_type)
);

insert into account_type
values ('Income'),
       ('Expense'),
       ('Asset'),
       ('Liability'),
       ('Equity')
ON DUPLICATE KEY UPDATE account_type = account_type;

create table if not exists address (
    id BINARY(16) not null,
    line1 varchar(100),
    line2 varchar(100),
    city varchar(100),
    state varchar(100),
    zipcode varchar(9),
    country varchar(2),

    constraint pk_address primary key (id)
);

create table if not exists tax_id_type (
    tax_id_type varchar(4) not null,

    constraint pk_tax_id_type primary key (tax_id_type)
);

insert into tax_id_type
values ('SSN'),
       ('EIN')
ON DUPLICATE KEY UPDATE tax_id_type = tax_id_type;

create table if not exists company (
    id BINARY(16) not null,
    company_name varchar(50) not null,
    tax_id varchar(9),
    tax_id_type varchar(4),
    address_id BINARY(16),
    website varchar(250),

    constraint pk_company primary key (id),
    constraint fk_company_tax_id_type foreign key (tax_id_type)
    references tax_id_type (tax_id_type),
    constraint fk_company_address foreign key (address_id)
    references address (id)
);

create table if not exists account (
    id BINARY(16) not null,
    company_id BINARY(16),
    account_name varchar(100) not null,
    account_type varchar(20) not null,
    is_system_account boolean not null,

    constraint pk_account primary key (id),
    constraint fk_account_company foreign key (company_id)
    references company (id),
    constraint fk_account_account_type foreign key (account_type)
    references account_type (account_type)
);

create table if not exists customer_type (
    customer_type varchar(20) not null,

    constraint pk_customer_type primary key (customer_type)
);

insert into customer_type
values ('Consumer'),
       ('Business')
ON DUPLICATE KEY UPDATE customer_type = customer_type;

create table if not exists contact_person (
    id BINARY(16) not null,
    first_name varchar(100),
    last_name varchar(100),
    address_id BINARY(16),
    email varchar(100),
    phone varchar(12),

    constraint pk_contact_person primary key (id),
    constraint fk_contact_person_address foreign key (address_id)
    references address (id)
);

create table if not exists customer (
    id BINARY(16) not null,
    customer_type varchar(20) not null,
    name varchar(100),
    first_name varchar(100),
    last_name varchar(100),
    address_id BINARY(16),
    website varchar(250),
    email varchar(100),
    phone varchar(12),
    primary_contact_id BINARY(16),

    constraint pk_customer primary key (id),
    constraint fk_customer_customer_type foreign key (customer_type)
    references customer_type (customer_type),
    constraint fk_customer_address foreign key (address_id)
    references address (id),
    constraint fk_customer_contact_person foreign key (primary_contact_id)
    references contact_person (id)
);

create table if not exists invoice (
    id BINARY(16) not null,
    customer_id BINARY(16) not null,
    invoice_number varchar(20),
    invoice_date date not null,
    due_date date not null,

    constraint pk_invoice primary key (id),
    constraint fk_invoice_customer foreign key (customer_id)
    references customer (id)
);

create table if not exists quantity_unit (
    quantity_unit varchar(40) not null,

    constraint pk_quantity_unit primary key (quantity_unit)
);

insert into quantity_unit
values ('Each'),
       ('Pound')
ON DUPLICATE KEY UPDATE quantity_unit = quantity_unit;

create table if not exists product (
    id binary(16) not null,
    product_name varchar(50) not null,
    description varchar(300) null,
    unit_price decimal(10,2) not null,
    quantity_unit varchar(40) not null,

    constraint pk_product primary key (id),
    constraint fk_product_quantity_unit foreign key (quantity_unit)
    references quantity_unit (quantity_unit)
);

create table if not exists invoice_line_item (
    invoice_id BINARY(16) not null,
    line_number integer not null,
    description varchar(100),
    quantity integer not null,
    product_id binary(16) not null,
    discount_rate decimal(3,2) null,

    constraint pk_invoice_line_item primary key (invoice_id, line_number),
    constraint fk_invoice_line_item_product foreign key (product_id)
    references product (id)
);

create table if not exists user_role (
    user_role varchar(20) not null,

    constraint pk_user_role primary key (user_role)
);

insert into user_role
values ('Admin'),
       ('Manager'),
       ('Bookkeeper')
ON DUPLICATE KEY UPDATE user_role = user_role;

create table if not exists users (
    id BINARY(16) not null,
    first_name varchar(100) not null,
    last_name varchar(100),
    email varchar(100) not null,
    phone varchar(12),
    user_role varchar(20) not null,

    constraint pk_user primary key (id),
    constraint fk_user_user_role foreign key (user_role)
    references user_role (user_role)
);

create table if not exists vendor (
    id BINARY(16) not null,
    vendor_name varchar(100) not null,
    website varchar(250),
    address_id BINARY(16),
    primary_contact_id BINARY(16),

    constraint pk_vendor primary key (id),
    constraint fk_vendor_address foreign key (address_id)
    references address (id),
    constraint fk_vendor_contact_person foreign key (primary_contact_id)
    references contact_person (id)
);

create table if not exists bill (
    id BINARY(16) not null,
    vendor_id BINARY(16) not null,
    due_date date,
    amount_due integer not null,

    constraint pk_bill primary key (id),
    constraint fk_bill_vendor foreign key (vendor_id)
    references vendor (id)
);

create table if not exists journal_entry (
    id binary(16) not null,
    description varchar(50) null,
    date_effective date not null,
    date_created timestamp not null default current_timestamp,

    constraint pk_journal_entry primary key (id)
);

create table if not exists transactions (
    id binary(16) not null,
    journal_entry_id binary(16) not null,
    account_id binary(16) not null,
    type enum('DEBIT', 'CREDIT') not null,
    description varchar(50) null,
    amount decimal(10,2) not null,

    constraint pk_transactions primary key (id),
    constraint fk_transactions_journal_entry foreign key (journal_entry_id) references journal_entry (id),
    constraint fk_transaction_account foreign key (account_id) references `account` (id)
);