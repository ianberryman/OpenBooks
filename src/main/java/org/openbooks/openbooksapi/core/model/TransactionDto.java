package org.openbooks.openbooksapi.core.model;

import java.math.BigDecimal;

public class TransactionDto {

    Long accountId;

    BigDecimal amount;

    AccountType accountType;

    public Long getAccountId() {
        return accountId;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public AccountType getAccountType() {
        return accountType;
    }
}
