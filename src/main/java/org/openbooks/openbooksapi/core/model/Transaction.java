package org.openbooks.openbooksapi.core.model;

import com.fasterxml.jackson.annotation.JsonIgnore;

import javax.persistence.*;
import java.math.BigDecimal;

/**
 * Represents a single adjustment to an account.
 * <p>
 * In a double entry accounting system, at least two adjustments
 * are required for every business transaction. For example, a
 * $500 inventory purchase would result in a $500 debit transaction
 * to increase the inventory account and a $500 credit transaction
 * to decrease the cash account. Both of these transactions would
 * be managed by a {@link DoubleEntryAccountingEntry} which, among
 * other things, ensures they are always in balance.
 */
@Entity(name = "ADJUSTMENT")
@Table(name = "ADJUSTMENT")
public class Transaction {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(updatable = false, insertable = false)
    private Long id;

    @ManyToOne
    @JoinColumn(name = "ACCOUNT_ID")
    @JsonIgnore
    private Account account;

    /*@Column(name = "ACCOUNT_ID", updatable = false, insertable = false)
    private Long accountId;*/

    @ManyToOne
    @JoinColumn(name = "ACCOUNTING_ENTRY_ID")
    @JsonIgnore
    private DoubleEntryAccountingEntry accountingEntry;

    /*@Column(name = "ACCOUNTING_ENTRY_ID", updatable = false, insertable = false)
    private Long accountingEntryId;*/

    private BigDecimal amount;

    @Enumerated(EnumType.STRING)
    private TransactionType transactionType;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public boolean idIsNull() {
        return this.id == null;
    }

    public Account parentAccount() {
        return account;
    }

    public void setAccount(Account account) {
        this.account = account;
    }

    public Long getAccountId() {
        return account.getId();
    }

    /*public void setAccountId(Long accountId) {
        this.accountId = accountId;
    }*/

    public DoubleEntryAccountingEntry parentAccountingEntry() {
        return accountingEntry;
    }

    public void setAccountingEntry(DoubleEntryAccountingEntry accountingEntry) {
        this.accountingEntry = accountingEntry;

        //this.accountingEntryId = accountingEntry.getId();
    }

    public Long getAccountingEntryId() {
        return accountingEntry.getId();
    }

    /*public void setAccountingEntryId(Long accountingEntryId) {
        this.accountingEntryId = accountingEntryId;
    }*/

    public BigDecimal getAmount() {
        return amount;
    }

    public void setAmount(BigDecimal amount) {
        this.amount = amount;
    }

    public TransactionType getTransactionType() {
        return transactionType;
    }

    public void setTransactionType(TransactionType transactionType) {
        this.transactionType = transactionType;
    }
}
