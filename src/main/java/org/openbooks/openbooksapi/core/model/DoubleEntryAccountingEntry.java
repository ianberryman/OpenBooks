package org.openbooks.openbooksapi.core.model;

import com.fasterxml.jackson.annotation.JsonIgnore;

import javax.persistence.*;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

@Entity(name = "ACCOUNTING_ENTRY")
@Table(name = "ACCOUNTING_ENTRY")
public class DoubleEntryAccountingEntry implements AccountingEntry {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String entryName;

    private String notes;

    @OneToMany(mappedBy = "accountingEntry",fetch = FetchType.EAGER,cascade = CascadeType.PERSIST)
    private List<Transaction> transactionList = new ArrayList<>();

    /**
     * Returns true if the child transactions add up to zero,
     * which indicates that the entry is balanced.
     * <p>
     * An entry should never be committed if it is not balanced.
     *
     * @return boolean
     */
    @JsonIgnore
    @Override
    public boolean isBalanced() {
        BigDecimal balance = BigDecimal.ZERO;

        // loop through transaction list and adjust balance based on type
        transactionList.forEach(
                transaction -> {
                    if (transaction.getTransactionType().equals(TransactionType.CREDIT)) {
                        balance.subtract(transaction.getAmount());
                    } else if (transaction.getTransactionType().equals(TransactionType.DEBIT)) {
                        balance.add(transaction.getAmount());
                    }
                });

        // return true if balance is zero
        return balance.equals(BigDecimal.ZERO);
    }

    @Override
    public Long getId() {
        return id;
    }

    @Override
    public void setId(Long id) {
        this.id = id;
    }

    public String getEntryName() {
        return entryName;
    }

    public void setEntryName(String entryName) {
        this.entryName = entryName;
    }

    public String getNotes() {
        return notes;
    }

    public void setNotes(String notes) {
        this.notes = notes;
    }

    @Override
    public List<Transaction> getTransactionList() {
        return transactionList;
    }

    @Override
    public void setTransactionList(List<Transaction> transactionList) {
        this.transactionList = transactionList;
    }

    @Override
    public void addTransaction(Transaction transaction) {
        this.transactionList.add(transaction);

        transaction.setAccountingEntry(this);
    }
}
