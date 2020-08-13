package org.openbooks.openbooksapi.core.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

import javax.persistence.*;
import java.util.List;

@Entity
public class Company {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @JsonProperty("name")
    private String companyName;

    @OneToMany(mappedBy = "company")
    @JsonIgnore
    private List<Account> accountList;

    public void addAccount(Account account) {
        accountList.add(account);

        account.setCompany(this);
    }

    public void removeAccount(Account account) {
        accountList.remove(account);

        account.setCompany(null);
    }

    public boolean idIsNull() {
        return id == null;
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getCompanyName() {
        return companyName;
    }

    public void setCompanyName(String companyName) {
        this.companyName = companyName;
    }

    public List<Account> getAccountList() {
        return accountList;
    }

    public void setAccountList(List<Account> accountList) {
        this.accountList = accountList;
    }
}
