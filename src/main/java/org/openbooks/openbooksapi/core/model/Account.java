package org.openbooks.openbooksapi.core.model;

import java.math.BigDecimal;

import javax.persistence.Column;
import javax.persistence.Entity;
import javax.persistence.GeneratedValue;
import javax.persistence.GenerationType;
import javax.persistence.Id;
import javax.persistence.PrePersist;

@Entity
public class Account {

	@Id
	@GeneratedValue(strategy = GenerationType.IDENTITY)
	private Long id;
	
	@Column(nullable = false)
	private String accountNumber;
	
	@Column(nullable = false)
	private BigDecimal balance;
	
	public Account() {}

	public Account(String accountNumber, BigDecimal balance) {
		this.accountNumber = accountNumber;
		this.balance = balance;
	}

	public Account(Long id, String accountNumber) {
		this.id = id;
		this.accountNumber = accountNumber;
	}

	public Account(Long id, String accountNumber, BigDecimal balance) {
		this.id = id;
		this.accountNumber = accountNumber;
		this.balance = balance;
	}
	
	@PrePersist
	public void prePersist() {
		if (balance == null) {
			balance = BigDecimal.ZERO;
		}
	}

	public Long getId() {
		return id;
	}

	public void setId(Long id) {
		this.id = id;
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
	
	
}
