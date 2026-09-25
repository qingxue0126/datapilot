CREATE DATABASE IF NOT EXISTS `datapilot_mock` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `datapilot_mock`;

CREATE TABLE organization (
  id BIGINT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  parent_id BIGINT NULL,
  status VARCHAR(20) NOT NULL,
  INDEX idx_org_parent (parent_id),
  CONSTRAINT fk_org_parent FOREIGN KEY (parent_id) REFERENCES organization(id)
) ENGINE=InnoDB;

CREATE TABLE department (
  id BIGINT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  organization_id BIGINT NOT NULL,
  parent_id BIGINT NULL,
  status VARCHAR(20) NOT NULL,
  INDEX idx_department_org (organization_id),
  CONSTRAINT fk_department_org FOREIGN KEY (organization_id) REFERENCES organization(id),
  CONSTRAINT fk_department_parent FOREIGN KEY (parent_id) REFERENCES department(id)
) ENGINE=InnoDB;

CREATE TABLE account (
  id BIGINT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL,
  normal_direction VARCHAR(10) NOT NULL,
  parent_code VARCHAR(32) NULL,
  status VARCHAR(20) NOT NULL,
  INDEX idx_account_category (category)
) ENGINE=InnoDB;

CREATE TABLE customer (
  id BIGINT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  organization_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL,
  INDEX idx_customer_org (organization_id),
  CONSTRAINT fk_customer_org FOREIGN KEY (organization_id) REFERENCES organization(id)
) ENGINE=InnoDB;

CREATE TABLE supplier (
  id BIGINT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  organization_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL,
  INDEX idx_supplier_org (organization_id),
  CONSTRAINT fk_supplier_org FOREIGN KEY (organization_id) REFERENCES organization(id)
) ENGINE=InnoDB;

CREATE TABLE voucher (
  id BIGINT PRIMARY KEY,
  voucher_no VARCHAR(40) NOT NULL UNIQUE,
  voucher_type VARCHAR(20) NOT NULL,
  fiscal_year INT NOT NULL,
  accounting_period INT NOT NULL,
  voucher_date DATE NOT NULL,
  posting_date DATE NULL,
  status VARCHAR(20) NOT NULL,
  organization_id BIGINT NOT NULL,
  INDEX idx_voucher_period_status (fiscal_year, accounting_period, status),
  CONSTRAINT fk_voucher_org FOREIGN KEY (organization_id) REFERENCES organization(id)
) ENGINE=InnoDB;

CREATE TABLE voucher_entry (
  id BIGINT PRIMARY KEY,
  voucher_id BIGINT NOT NULL,
  voucher_no VARCHAR(40) NOT NULL,
  voucher_type VARCHAR(20) NOT NULL,
  fiscal_year INT NOT NULL,
  accounting_period INT NOT NULL,
  voucher_date DATE NOT NULL,
  account_id BIGINT NULL,
  account_code VARCHAR(32) NULL,
  debit_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  credit_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  currency_code CHAR(3) NOT NULL DEFAULT 'CNY',
  original_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  exchange_rate DECIMAL(18,6) NOT NULL DEFAULT 1,
  customer_id BIGINT NULL,
  supplier_id BIGINT NULL,
  department_id BIGINT NULL,
  organization_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL,
  line_no INT NOT NULL,
  description VARCHAR(200) NOT NULL,
  INDEX idx_entry_period_status (fiscal_year, accounting_period, status),
  INDEX idx_entry_account_date (account_code, voucher_date),
  INDEX idx_entry_customer (customer_id),
  INDEX idx_entry_supplier (supplier_id),
  INDEX idx_entry_department (department_id),
  CONSTRAINT fk_entry_voucher FOREIGN KEY (voucher_id) REFERENCES voucher(id),
  CONSTRAINT fk_entry_account_id FOREIGN KEY (account_id) REFERENCES account(id),
  CONSTRAINT fk_entry_customer FOREIGN KEY (customer_id) REFERENCES customer(id),
  CONSTRAINT fk_entry_supplier FOREIGN KEY (supplier_id) REFERENCES supplier(id),
  CONSTRAINT fk_entry_department FOREIGN KEY (department_id) REFERENCES department(id),
  CONSTRAINT fk_entry_org FOREIGN KEY (organization_id) REFERENCES organization(id)
) ENGINE=InnoDB;

CREATE TABLE receivable (
  id BIGINT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  voucher_id BIGINT NULL,
  amount DECIMAL(18,2) NOT NULL,
  balance DECIMAL(18,2) NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'CNY',
  due_date DATE NOT NULL,
  business_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL,
  organization_id BIGINT NOT NULL,
  INDEX idx_receivable_status_customer (status, customer_id),
  INDEX idx_receivable_date (business_date),
  CONSTRAINT fk_receivable_customer FOREIGN KEY (customer_id) REFERENCES customer(id),
  CONSTRAINT fk_receivable_voucher FOREIGN KEY (voucher_id) REFERENCES voucher(id),
  CONSTRAINT fk_receivable_org FOREIGN KEY (organization_id) REFERENCES organization(id)
) ENGINE=InnoDB;

CREATE TABLE payable (
  id BIGINT PRIMARY KEY,
  supplier_id BIGINT NOT NULL,
  voucher_id BIGINT NULL,
  amount DECIMAL(18,2) NOT NULL,
  balance DECIMAL(18,2) NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'CNY',
  due_date DATE NOT NULL,
  business_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL,
  organization_id BIGINT NOT NULL,
  INDEX idx_payable_status_supplier (status, supplier_id),
  INDEX idx_payable_date (business_date),
  CONSTRAINT fk_payable_supplier FOREIGN KEY (supplier_id) REFERENCES supplier(id),
  CONSTRAINT fk_payable_voucher FOREIGN KEY (voucher_id) REFERENCES voucher(id),
  CONSTRAINT fk_payable_org FOREIGN KEY (organization_id) REFERENCES organization(id)
) ENGINE=InnoDB;

CREATE TABLE erp_anomaly_case (
  id INT PRIMARY KEY,
  case_type VARCHAR(60) NOT NULL UNIQUE,
  fixture_reference VARCHAR(120) NOT NULL,
  expected_action VARCHAR(30) NOT NULL,
  description VARCHAR(300) NOT NULL
) ENGINE=InnoDB;
