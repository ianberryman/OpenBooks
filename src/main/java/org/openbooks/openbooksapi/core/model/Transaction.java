package org.openbooks.openbooksapi.core.model;

import javax.persistence.Column;
import javax.persistence.Entity;
import javax.persistence.GeneratedValue;
import javax.persistence.GenerationType;
import javax.persistence.Id;
import javax.persistence.JoinColumn;
import javax.persistence.ManyToOne;

@Entity
public class Transaction {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(updatable = false, insertable = false)
    private Long id;

    @ManyToOne(targetEntity = Account.class)
    @JoinColumn(name = "ACCOUNT_ID")
    private Account account;

    @Column(name = "ACCOUNT_ID", updatable = false, insertable = false)
    private Long accountId;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public boolean idIsNull() {
        return this.id == null;
    }

/*	public Long getAccount() {
		return account.getId();
	}*/

    public Account parentAccount() {
        return account;
    }

    public void setAccount(Account account) {
        this.account = account;
    }

    public Long getAccountId() {
        return accountId;
    }

    public void setAccountId(Long accountId) {
        this.accountId = accountId;
    }



}
