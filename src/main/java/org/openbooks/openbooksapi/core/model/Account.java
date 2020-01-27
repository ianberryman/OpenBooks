package org.openbooks.openbooksapi.core.model;

import com.fasterxml.jackson.annotation.JsonIgnore;

import javax.persistence.*;
import java.math.BigDecimal;
import java.util.List;

@Entity
public class Account {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(updatable = false, insertable = false)
    private Long id;

    @ManyToOne(optional = false)
    @JoinColumn(name = "COMPANY_ID")
    private Company company;

    /**
     * Public accessor allows companyId to be retrieved
     * during Account creation
     */
    @Transient
    public Long companyId;

    private String accountNumber;

    private String nickname;

    @Enumerated(EnumType.STRING)
    private AccountType accountType;

    @Column(updatable = false)
    private BigDecimal balance;

    @OneToMany(mappedBy = "account")
    private List<Transaction> transactionList;

    public Account() {}

    @PrePersist
    private void prePersist() {
        if (this.balance == null) this.balance = BigDecimal.ZERO;
    }

    public boolean idIsNull() {
        return this.id == null;
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    @JsonIgnore
    public Company getCompany() {
        return company;
    }

    @JsonIgnore
    public void setCompany(Company company) {
        this.company = company;
    }

    public Long getCompanyId() {
        return company.getId();
    }

    public String getCompanyName() {
        return company.getCompanyName();
    }

    public BigDecimal getBalance() {
        return balance;
    }

    public void setBalance(BigDecimal balance) {
        this.balance = balance;
    }

    public String getAccountNumber() {
        return accountNumber;
    }

    public void setAccountNumber(String accountNumber) {
        this.accountNumber = accountNumber;
    }

    public String getNickname() {
        return nickname;
    }

    public void setNickname(String nickname) {
        this.nickname = nickname;
    }

    public AccountType getAccountType() {
        return accountType;
    }

    public void setAccountType(AccountType accountType) {
        this.accountType = accountType;
    }
}
